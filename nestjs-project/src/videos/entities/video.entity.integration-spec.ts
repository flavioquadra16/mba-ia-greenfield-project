import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video } from './video.entity';
import { VideoStatus } from '../video.constants';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let users: Repository<User>;
  let channels: Repository<Channel>;
  let videos: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
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

  async function createChannel(): Promise<Channel> {
    const user = await users.save(
      users.create({
        email: `video-${Date.now()}-${Math.random()}@example.com`,
        password: 'hashed',
      }),
    );
    return channels.save(
      channels.create({
        name: 'Channel',
        nickname: `ch${Math.random().toString(36).slice(2, 10)}`,
        user_id: user.id,
      }),
    );
  }

  function draft(channelId: string, publicId: string): Partial<Video> {
    return {
      id: crypto.randomUUID(),
      public_id: publicId,
      channel_id: channelId,
      title: 'Demo',
      status: VideoStatus.Draft,
      original_key: `videos/${publicId}/original.mp4`,
      content_type: 'video/mp4',
      size_bytes: 1024,
    };
  }

  it('defaults status to draft and leaves processing fields empty', async () => {
    const channel = await createChannel();
    const saved = await videos.save(
      videos.create(draft(channel.id, 'abc123def45')),
    );

    expect(saved.status).toBe(VideoStatus.Draft);
    expect(saved.thumbnail_key).toBeNull();
    expect(saved.duration_seconds).toBeNull();
    expect(saved.metadata).toBeNull();
  });

  it('rejects a duplicate public id', async () => {
    const channel = await createChannel();
    await videos.save(videos.create(draft(channel.id, 'abc123def45')));

    await expect(
      videos.save(videos.create(draft(channel.id, 'abc123def45'))),
    ).rejects.toThrow();
  });

  it('rejects a video whose channel does not exist', async () => {
    await expect(
      videos.save(
        videos.create(
          draft('00000000-0000-4000-8000-000000000000', 'zzz123def45'),
        ),
      ),
    ).rejects.toThrow();
  });
});
