import { createReadStream, createWriteStream } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';

export interface CompletedUploadPart {
  partNumber: number;
  etag: string;
}

export interface PresignedPart {
  partNumber: number;
  url: string;
}

export interface PresignedGet {
  url: string;
  expiresAt: string;
}

@Injectable()
export class StorageService {
  private readonly operations: S3Client;
  private readonly signer: S3Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
    @Inject(videoConfig.KEY)
    private readonly video: ConfigType<typeof videoConfig>,
  ) {
    this.operations = this.createClient(storage.endpoint);
    this.signer = this.createClient(storage.publicEndpoint);
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const result = await this.operations.send(
      new CreateMultipartUploadCommand({
        Bucket: this.storage.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!result.UploadId) {
      throw new Error('Object storage did not return an upload id');
    }
    return result.UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return getSignedUrl(
      this.signer,
      new UploadPartCommand({
        Bucket: this.storage.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: this.video.uploadUrlExpiresSeconds },
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedUploadPart[],
  ): Promise<void> {
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    await this.operations.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.storage.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: ordered.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.operations.send(
        new AbortMultipartUploadCommand({
          Bucket: this.storage.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch {
      // Already aborted or never created. The row still moves to error.
    }
  }

  async presignGetObject(
    key: string,
    options?: { downloadFilename?: string },
  ): Promise<PresignedGet> {
    const expiresIn = this.video.playbackUrlExpiresSeconds;
    const url = await getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.storage.bucket,
        Key: key,
        ResponseContentDisposition: options?.downloadFilename
          ? `attachment; filename="${options.downloadFilename}"`
          : undefined,
      }),
      { expiresIn },
    );
    return {
      url,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
  }

  async downloadToFile(key: string, destination: string): Promise<void> {
    const result = await this.operations.send(
      new GetObjectCommand({
        Bucket: this.storage.bucket,
        Key: key,
      }),
    );
    if (!result.Body) {
      throw new Error(`Object ${key} has an empty body`);
    }
    const body =
      result.Body instanceof Readable
        ? result.Body
        : Readable.from(result.Body as AsyncIterable<Uint8Array>);
    await pipeline(body, createWriteStream(destination));
  }

  async putFile(
    key: string,
    sourcePath: string,
    contentType: string,
  ): Promise<void> {
    await this.operations.send(
      new PutObjectCommand({
        Bucket: this.storage.bucket,
        Key: key,
        Body: createReadStream(sourcePath),
        ContentType: contentType,
      }),
    );
  }

  private createClient(endpoint: string): S3Client {
    return new S3Client({
      region: this.storage.region,
      endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: this.storage.accessKey,
        secretAccessKey: this.storage.secretKey,
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
}
