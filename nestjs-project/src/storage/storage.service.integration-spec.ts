import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { envValidationSchema } from '../config/env.validation';
import { getRange, putBinary } from '../test/http-binary';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageService (integration)', () => {
  let service: StorageService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videoConfig],
          validationSchema: envValidationSchema,
          validationOptions: { allowUnknown: true, abortEarly: false },
        }),
        StorageModule,
      ],
    }).compile();
    service = moduleRef.get(StorageService);
  });

  it('uploads one part through a presigned URL and answers Range with 206', async () => {
    const key = `tests/${randomUUID()}/original.bin`;
    const body = Buffer.from('0123456789abcdef-streamtube-bytes');
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const url = await service.presignUploadPart(key, uploadId, 1);

    const put = await putBinary(url, body);
    expect(put.status).toBe(200);
    expect(put.etag).toEqual(expect.any(String));

    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: put.etag as string },
    ]);

    const signed = await service.presignGetObject(key);
    const ranged = await getRange(signed.url, 'bytes=0-15');
    expect(ranged.status).toBe(206);
    expect(ranged.contentRange).toContain('bytes 0-15/');
    expect(ranged.length).toBe(16);
  });

  it('aborts a multipart upload that was never completed', async () => {
    const key = `tests/${randomUUID()}/aborted.bin`;
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    await expect(
      service.abortMultipartUpload(key, uploadId),
    ).resolves.toBeUndefined();
  });
});
