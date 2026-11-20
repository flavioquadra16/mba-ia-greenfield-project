import { execFile } from 'child_process';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFile } from 'fs/promises';
import { promisify } from 'util';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { getRange, putBinary } from '../src/test/http-binary';
import { cleanAllTables } from '../src/test/create-test-data-source';

const execFileAsync = promisify(execFile);

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();
    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function accessToken(email: string): Promise<string> {
    const authService = app.get(AuthService);
    let captured = '';
    const mail = (authService as any).mailService;
    jest
      .spyOn(mail, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, token: string) => {
        captured = token;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password123' })
      .expect(201);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: captured })
      .expect(204);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'password123' })
      .expect(200);
    return login.body.access_token as string;
  }

  async function sampleVideo(): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'e2e-video-'));
    const file = join(dir, 'sample.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=160x120:d=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-t',
      '1',
      file,
    ]);
    return readFile(file);
  }

  async function waitUntilReady(token: string, id: string) {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const res = await request(app.getHttpServer())
        .get(`/videos/${id}`)
        .set('Authorization', `Bearer ${token}`);
      if (res.status === 200 && res.body.status === 'ready') return res.body;
      if (res.status === 200 && res.body.status === 'error') {
        throw new Error(res.body.processingError ?? 'processing failed');
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('video was not ready before the timeout');
  }

  it('rejects an unauthenticated initiate', async () => {
    await request(app.getHttpServer())
      .post('/videos')
      .send({
        title: 'Nope',
        filename: 'nope.mp4',
        contentType: 'video/mp4',
        sizeBytes: 10,
      })
      .expect(401);
  });

  it('rejects a file larger than 10GiB before creating a row', async () => {
    const token = await accessToken('big@example.com');
    const before = await dataSource.query(
      'SELECT COUNT(*)::int AS count FROM videos',
    );

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Too big',
        filename: 'huge.mp4',
        contentType: 'video/mp4',
        sizeBytes: 10 * 1024 * 1024 * 1024 + 1,
      })
      .expect(400);

    expect(res.body.error).toBe('VALIDATION_ERROR');
    const after = await dataSource.query(
      'SELECT COUNT(*)::int AS count FROM videos',
    );
    expect(after[0].count).toBe(before[0].count);
  });

  it('uploads directly to storage, processes, and streams a range', async () => {
    const token = await accessToken('uploader@example.com');
    const file = await sampleVideo();

    const first = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'First clip',
        filename: 'first.mp4',
        contentType: 'video/mp4',
        sizeBytes: file.length,
      })
      .expect(201);
    const second = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Second clip',
        filename: 'second.mp4',
        contentType: 'video/mp4',
        sizeBytes: file.length,
      })
      .expect(201);

    expect(first.body.status).toBe('draft');
    expect(first.body.publicId).toHaveLength(11);
    expect(second.body.publicId).not.toBe(first.body.publicId);

    await request(app.getHttpServer())
      .get(`/videos/public/${first.body.publicId}`)
      .expect(404);

    const put = await putBinary(first.body.parts[0].url, file);
    expect(put.status).toBe(200);

    await request(app.getHttpServer())
      .post(`/videos/${first.body.id}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: [{ partNumber: 1, etag: put.etag }] })
      .expect(202);

    const ready = await waitUntilReady(token, first.body.id);
    expect(ready.durationSeconds).toBeGreaterThanOrEqual(1);
    expect(ready.thumbnailUrl).toEqual(expect.any(String));

    const playback = await request(app.getHttpServer())
      .get(`/videos/public/${first.body.publicId}/playback`)
      .expect(200);
    const ranged = await getRange(playback.body.url, 'bytes=0-15');
    expect(ranged.status).toBe(206);
    expect(ranged.length).toBe(16);

    const download = await request(app.getHttpServer())
      .get(`/videos/public/${first.body.publicId}/download`)
      .expect(200);
    expect(download.body.url).toContain('response-content-disposition');
    expect(download.body.filename).toBe('First-clip.mp4');
  }, 60_000);
});
