import { AuthenticatedUser } from '@app/common';
import {
  ClassSerializerInterceptor,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { User } from '../users/entities/user.entity';
import { AnalysisService } from './analysis.service';
import { LapCompareDto, LapTraceDto } from './dto/lap-trace.dto';
import { LapsResponseDto } from './dto/laps-response.dto';
import {
  DEFAULT_TRACE_POINTS,
  QueryCompareDto,
  QueryTraceDto,
} from './dto/query-trace.dto';

/**
 * Post-session analysis, hung off `sessions/:id` because that is what it is
 * about — a separate controller from `SessionsController` only so the
 * derivation lives in its own module.
 *
 * Every route scopes through `SessionsService.requireReadableSession`, inside
 * `AnalysisService`. A session on another team's car 404s here exactly as it
 * does on `GET /sessions/:id`.
 */
@Controller('sessions')
@UseGuards(JwtAuthGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class AnalysisController {
  constructor(private readonly analysisService: AnalysisService) {}

  /** Derives on the first call for a completed session; a select thereafter. */
  @Get(':id/laps')
  getLaps(
    @AuthenticatedUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LapsResponseDto> {
    return this.analysisService.getLaps(user, id);
  }

  // 200, not 201: this replaces a derivation, it does not create a resource.
  @Post(':id/analyze')
  @HttpCode(HttpStatus.OK)
  analyze(
    @AuthenticatedUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LapsResponseDto> {
    return this.analysisService.recompute(user, id);
  }

  /**
   * One lap's racing line and channels, distance-indexed.
   *
   * Declared before `:id/laps` would matter if the two could collide; they
   * cannot, since `:n` is an integer segment under `laps`.
   */
  @Get(':id/laps/:n/trace')
  getLapTrace(
    @AuthenticatedUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('n', ParseIntPipe) lapNumber: number,
    @Query() query: QueryTraceDto,
  ): Promise<LapTraceDto> {
    return this.analysisService.getLapTrace(
      user,
      id,
      lapNumber,
      query.maxPoints ?? DEFAULT_TRACE_POINTS,
    );
  }

  /** The lap-vs-lap delta — where the time actually went. */
  @Get(':id/compare')
  compare(
    @AuthenticatedUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: QueryCompareDto,
  ): Promise<LapCompareDto> {
    return this.analysisService.compare(
      user,
      id,
      query.laps,
      query.maxPoints ?? DEFAULT_TRACE_POINTS,
    );
  }

  /**
   * The optimal lap's racing line — each sector's geometry from the lap that
   * set it, stitched together. 404 when there are fewer than two eligible
   * laps, per the shared specification.
   */
  @Get(':id/optimal/trace')
  getOptimalTrace(
    @AuthenticatedUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: QueryTraceDto,
  ): Promise<LapTraceDto> {
    return this.analysisService.getOptimalTrace(
      user,
      id,
      query.maxPoints ?? DEFAULT_TRACE_POINTS,
    );
  }
}
