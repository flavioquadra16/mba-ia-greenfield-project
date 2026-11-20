import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import {
  CompleteUploadDto,
  InitiateUploadDto,
  RefreshUploadPartsDto,
} from './dto/upload.dto';
import { VideosService } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @ApiBearerAuth('access-token')
  @Post()
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Creates the video as a draft and returns presigned URLs. The file is uploaded directly to object storage, not through this API.',
  })
  @ApiResponse({ status: 201, description: 'Draft created and parts signed' })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Channel not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  initiate(@CurrentUser() user: JwtPayload, @Body() dto: InitiateUploadDto) {
    return this.videosService.initiate(user.sub, dto);
  }

  @ApiBearerAuth('access-token')
  @Post(':id/upload/parts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh presigned part URLs',
    description:
      'Re-signs upload parts for a draft so a dropped connection can resume without sending bytes through the API.',
  })
  @ApiResponse({ status: 200, description: 'Part URLs refreshed' })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or parts are out of range',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload is not awaiting completion',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  refreshParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RefreshUploadPartsDto,
  ) {
    return this.videosService.refreshParts(user.sub, id, dto.partNumbers);
  }

  @ApiBearerAuth('access-token')
  @Post(':id/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Complete a multipart upload',
    description:
      'Finalizes the object in storage, marks the video as processing, and enqueues background processing.',
  })
  @ApiResponse({ status: 202, description: 'Processing enqueued' })
  @ApiResponse({
    status: 400,
    description: 'Parts do not match the declared size',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload is not awaiting completion',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  complete(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ) {
    return this.videosService.completeUpload(user.sub, id, dto);
  }

  @ApiBearerAuth('access-token')
  @Post(':id/upload/abort')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Abort a draft upload',
    description:
      'Aborts the multipart upload and marks the video as error. Allowed only while the video is a draft.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted' })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload is not awaiting completion',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  abort(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.videosService.abortUpload(user.sub, id);
  }

  @Public()
  @Get('public/:publicId')
  @ApiOperation({
    summary: 'Read a ready video by its public id',
    description:
      'Anonymous read of a processed video. Drafts and failed videos are hidden.',
  })
  @ApiResponse({ status: 200, description: 'Ready video' })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  findPublic(@Param('publicId') publicId: string) {
    return this.videosService.getPublic(publicId);
  }

  @Public()
  @Get('public/:publicId/playback')
  @ApiOperation({
    summary: 'Get a streaming URL',
    description:
      'Returns a presigned GET URL. The client streams with HTTP Range against object storage and does not download the file through the API.',
  })
  @ApiResponse({ status: 200, description: 'Presigned playback URL' })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  playback(@Param('publicId') publicId: string) {
    return this.videosService.playback(publicId);
  }

  @Public()
  @Get('public/:publicId/download')
  @ApiOperation({
    summary: 'Get a download URL',
    description:
      'Returns a presigned GET URL with an attachment content disposition.',
  })
  @ApiResponse({ status: 200, description: 'Presigned download URL' })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  download(@Param('publicId') publicId: string) {
    return this.videosService.download(publicId);
  }

  @ApiBearerAuth('access-token')
  @Get(':id')
  @ApiOperation({
    summary: 'Read a video owned by the caller',
    description:
      'Returns the video in any status. The id is the UUID, not the public id.',
  })
  @ApiResponse({ status: 200, description: 'Video owned by the caller' })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  findOne(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.videosService.getForOwner(user.sub, id);
  }
}
