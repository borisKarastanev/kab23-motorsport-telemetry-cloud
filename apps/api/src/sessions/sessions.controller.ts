import { AuthenticatedUser } from '@app/common';
import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { User } from '../users/entities/user.entity';
import { SessionsService } from './sessions.service';
import { Session } from './entities/session.entity';
import { CreateSessionDto } from './dto/create-session.dto';
import { UpdateSessionDto } from './dto/update-session.dto';
import { QuerySessionsDto } from './dto/query-sessions.dto';
import { QueryTelemetryDto } from './dto/query-telemetry.dto';
import { TelemetryPointDto } from './dto/telemetry-point.dto';

@Controller('sessions')
@UseGuards(JwtAuthGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class SessionsController {
  constructor(private readonly sessionsService: SessionsService) {}

  @Post()
  create(
    @AuthenticatedUser() user: User,
    @Body() createSessionDto: CreateSessionDto,
  ): Promise<Session> {
    return this.sessionsService.create(user, createSessionDto);
  }

  @Get()
  findAll(
    @AuthenticatedUser() user: User,
    @Query() query: QuerySessionsDto,
  ): Promise<Session[]> {
    return this.sessionsService.findAll(user, query);
  }

  @Get(':id')
  findOne(
    @AuthenticatedUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Session> {
    return this.sessionsService.findOne(user, id);
  }

  /**
   * Downsampled telemetry for one session — the Phase 2 write path's proof of
   * life, not the Phase 4 analysis API.
   */
  @Get(':id/telemetry')
  getTelemetry(
    @AuthenticatedUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: QueryTelemetryDto,
  ): Promise<TelemetryPointDto[]> {
    return this.sessionsService.getTelemetry(user, id, query);
  }

  @Patch(':id')
  update(
    @AuthenticatedUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateSessionDto: UpdateSessionDto,
  ): Promise<Session> {
    return this.sessionsService.update(user, id, updateSessionDto);
  }

  // 200, not Nest's default 201 for POST: closing transitions an existing
  // session, it does not create a resource.
  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  close(
    @AuthenticatedUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Session> {
    return this.sessionsService.close(user, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @AuthenticatedUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.sessionsService.remove(user, id);
  }
}
