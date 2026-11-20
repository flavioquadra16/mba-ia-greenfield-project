import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { envValidationSchema } from '../config/env.validation';
import { VIDEO_PROCESSING_QUEUE } from '../queue/video-processing.constants';
import { putBinary } from '../test/http-binary';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoStatus } from './video.constants';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService upload (integration)', () => {
  let dataSource: DataSource;
  let service: VideosService;
  let queue: Queue;
  let users: Repository<User>;
  let channels: Repository<Channel>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, storageConfig, queueConfig, videoConfig],
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
        VideosModule,
      ],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    service = moduleRef.get(VideosService);
    queue = moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    users = dataSource.getRepository(User);
    channels = dataSource.getRepository(Channel);
  });

  afterAll(async () => {
    await queue.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function createUserWithChannel(): Promise<{
    user: User;
    channel: Channel;
  }> {
    const user = await users.save(
      users.create({
        email: `upload-${Date.now()}-${Math.random()}@example.com`,
        password: 'hashed',
        is_confirmed: true,
      }),
    );
    const channel = await channels.save(
      channels.create({
        name: 'Uploader',
        nickname: `up${Math.random().toString(36).slice(2, 10)}`,
        user_id: user.id,
      }),
    );
    return { user, channel };
  }

  it('stores a draft before any byte is uploaded, then enqueues processing', async () => {
    const { user } = await createUserWithChannel();
    const body = Buffer.from('small-video-bytes-for-one-part');

    const initiated = await service.initiate(user.id, {
      title: 'Integration',
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: body.length,
    });

    const draft = await dataSource.getRepository(Video).findOneByOrFail({
      id: initiated.id,
    });
    expect(draft.status).toBe(VideoStatus.Draft);
    expect(draft.public_id).toBe(initiated.publicId);

    const put = await putBinary(initiated.parts[0].url, body);
    expect(put.status).toBe(200);

    const completed = await service.completeUpload(user.id, initiated.id, {
      parts: [{ partNumber: 1, etag: put.etag as string }],
    });
    expect(completed.status).toBe(VideoStatus.Processing);

    const row = await dataSource.getRepository(Video).findOneByOrFail({
      id: initiated.id,
    });
    expect([VideoStatus.Processing, VideoStatus.Ready]).toContain(row.status);
    if (row.status === VideoStatus.Processing) {
      const job = await queue.getJob(initiated.id);
      expect(job?.id).toBe(initiated.id);
    }
  });
});
