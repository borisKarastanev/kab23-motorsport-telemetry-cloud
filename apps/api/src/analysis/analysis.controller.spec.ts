import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { User } from '../users/entities/user.entity';
import { LapsResponseDto } from './dto/laps-response.dto';
import { LapCompareDto, LapTraceDto } from './dto/lap-trace.dto';
import {
  DEFAULT_TRACE_POINTS,
  QueryCompareDto,
  QueryTraceDto,
} from './dto/query-trace.dto';

const SESSION_ID = 'session-1';

const asUser = (id: string) => ({ id, email: `${id}@example.test` }) as User;

const lapsResponse = (overrides: Partial<LapsResponseDto> = {}) =>
  ({ laps: [], analyzedAt: null, ...overrides }) as LapsResponseDto;

describe('AnalysisController', () => {
  let controller: AnalysisController;
  let analysisService: jest.Mocked<Partial<AnalysisService>>;

  beforeEach(() => {
    analysisService = {
      getLaps: jest.fn(),
      recompute: jest.fn(),
      getLapTrace: jest.fn(),
      compare: jest.fn(),
    };

    controller = new AnalysisController(
      analysisService as unknown as AnalysisService,
    );
  });

  it('getLaps delegates to the service with user and session id', async () => {
    const user = asUser('user-1');
    const result = lapsResponse();
    analysisService.getLaps!.mockResolvedValue(result);

    await expect(controller.getLaps(user, SESSION_ID)).resolves.toBe(result);
    expect(analysisService.getLaps).toHaveBeenCalledWith(user, SESSION_ID);
  });

  it('analyze delegates to recompute with user and session id', async () => {
    const user = asUser('user-1');
    const result = lapsResponse();
    analysisService.recompute!.mockResolvedValue(result);

    await expect(controller.analyze(user, SESSION_ID)).resolves.toBe(result);
    expect(analysisService.recompute).toHaveBeenCalledWith(user, SESSION_ID);
  });

  describe('getLapTrace', () => {
    it('uses the requested maxPoints when present', async () => {
      const user = asUser('user-1');
      const query: QueryTraceDto = { maxPoints: 250 };
      const trace = { lapNumber: 2 } as LapTraceDto;
      analysisService.getLapTrace!.mockResolvedValue(trace);

      await expect(
        controller.getLapTrace(user, SESSION_ID, 2, query),
      ).resolves.toBe(trace);
      expect(analysisService.getLapTrace).toHaveBeenCalledWith(
        user,
        SESSION_ID,
        2,
        250,
      );
    });

    it('falls back to DEFAULT_TRACE_POINTS when maxPoints is absent', async () => {
      const user = asUser('user-1');
      const query: QueryTraceDto = {};
      const trace = { lapNumber: 2 } as LapTraceDto;
      analysisService.getLapTrace!.mockResolvedValue(trace);

      await controller.getLapTrace(user, SESSION_ID, 2, query);

      expect(analysisService.getLapTrace).toHaveBeenCalledWith(
        user,
        SESSION_ID,
        2,
        DEFAULT_TRACE_POINTS,
      );
    });
  });

  describe('compare', () => {
    it('uses the requested laps and maxPoints when present', async () => {
      const user = asUser('user-1');
      const query: QueryCompareDto = { laps: [2, 5], maxPoints: 300 };
      const comparison = { lapA: 2, lapB: 5 } as LapCompareDto;
      analysisService.compare!.mockResolvedValue(comparison);

      await expect(controller.compare(user, SESSION_ID, query)).resolves.toBe(
        comparison,
      );
      expect(analysisService.compare).toHaveBeenCalledWith(
        user,
        SESSION_ID,
        [2, 5],
        300,
      );
    });

    it('falls back to DEFAULT_TRACE_POINTS when maxPoints is absent', async () => {
      const user = asUser('user-1');
      const query: QueryCompareDto = { laps: [1, 3] };
      const comparison = { lapA: 1, lapB: 3 } as LapCompareDto;
      analysisService.compare!.mockResolvedValue(comparison);

      await controller.compare(user, SESSION_ID, query);

      expect(analysisService.compare).toHaveBeenCalledWith(
        user,
        SESSION_ID,
        [1, 3],
        DEFAULT_TRACE_POINTS,
      );
    });
  });
});
