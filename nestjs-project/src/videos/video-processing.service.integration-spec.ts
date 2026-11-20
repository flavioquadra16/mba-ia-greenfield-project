import { execFile } from 'child_process';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import databaseConfig from '../config/database.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { envValidationSchema } from '../config/env.validation';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoProcessingService } from './video-processing.service';
import { originalObjectKey, VideoStatus } from './video.constants';

const execFileAsync = promisify(execFile);
const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoProcessingService (integration)', () => {
  let dataSource: DataSource;
  let processing: VideoProcessingService;
  let storage: StorageService;
  let users: Repository<User>;
  let channels: Repository<Channel>;
  let videos: Repository<Video>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, storageConfig, videoConfig],
          validationSchema: envValidationSchema,
          validationOptions: { allowUnknown: true, abortEarly: false },
        }),
        TypeOrmModule.forRootAsync({
          inject: [databaseConfig.KEY],
          useFactory: (db: ConfigType<typeof databaseConfig>) => ({
            type: 'postgres' as const,
            host: db.host,
            port: db.port,
            username: db.username,
            password: db.password,
            database: db.name,
            entities: ALL_ENTITIES,
            synchronize: false,
          }),
        }),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [VideoProcessingService],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    processing = moduleRef.get(VideoProcessingService);
    storage = moduleRef.get(StorageService);
    users = dataSource.getRepository(User);
    channels = dataSource.getRepository(Channel);
    videos = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function createProcessingVideo(contentType: string): Promise<Video> {
    const user = await users.save(
      users.create({
        email: `proc-${Date.now()}-${Math.random()}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channels.save(
      channels.create({
        name: 'Proc',
        nickname: `pr${Math.random().toString(36).slice(2, 10)}`,
        user_id: user.id,
      }),
    );
    const id = randomUUID();
    return videos.save(
      videos.create({
        id,
        public_id: randomUUID().replace(/-/g, '').slice(0, 11),
        channel_id: channel.id,
        title: 'Processed',
        status: VideoStatus.Processing,
        original_key: originalObjectKey(id, contentType),
        content_type: contentType,
        size_bytes: 1,
      }),
    );
  }

  it('extracts duration and stores a thumbnail for a real video', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sample-'));
    const file = join(dir, 'sample.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=160x120:d=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-t',
      '1',
      file,
    ]);

    const video = await createProcessingVideo('video/mp4');
    await storage.putFile(video.original_key, file, 'video/mp4');

    await processing.process(video.id);

    const ready = await videos.findOneByOrFail({ id: video.id });
    expect(ready.status).toBe(VideoStatus.Ready);
    expect(ready.duration_seconds).toBeGreaterThanOrEqual(1);
    expect(ready.metadata?.width).toBe(160);
    expect(ready.metadata?.height).toBe(120);
    expect(ready.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
  });

  it('records an error when the object is not a video', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bad-'));
    const file = join(dir, 'notes.txt');
    await writeFile(file, 'this is not a video');

    const video = await createProcessingVideo('video/mp4');
    await storage.putFile(video.original_key, file, 'video/mp4');

    await expect(processing.process(video.id)).rejects.toThrow();
    await processing.markFailed(video.id, 'ffprobe failed');

    const failed = await videos.findOneByOrFail({ id: video.id });
    expect(failed.status).toBe(VideoStatus.Error);
    expect(failed.processing_error).toBe('ffprobe failed');
  });
});
