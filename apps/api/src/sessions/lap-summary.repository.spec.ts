import { DataSource } from 'typeorm';
import { LapSummaryRepository } from './lap-summary.repository';

describe('LapSummaryRepository', () => {
  let dataSource: jest.Mocked<Partial<DataSource>>;
  let repository: LapSummaryRepository;

  beforeEach(() => {
    dataSource = { query: jest.fn() };
    repository = new LapSummaryRepository(dataSource as unknown as DataSource);
  });

  it('returns an empty map without querying when given no session ids', async () => {
    await expect(repository.findBySessions([])).resolves.toEqual(new Map());
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('keys the result by sessionId', async () => {
    (dataSource.query as jest.Mock).mockResolvedValue([
      { sessionId: 'session-1', lapCount: 12, bestLapMs: 91234 },
      { sessionId: 'session-2', lapCount: 3, bestLapMs: null },
    ]);

    const result = await repository.findBySessions(['session-1', 'session-2']);

    expect(result.get('session-1')).toEqual({
      sessionId: 'session-1',
      lapCount: 12,
      bestLapMs: 91234,
    });
    expect(result.get('session-2')).toEqual({
      sessionId: 'session-2',
      lapCount: 3,
      bestLapMs: null,
    });
    expect(dataSource.query).toHaveBeenCalledWith(expect.any(String), [
      ['session-1', 'session-2'],
    ]);
  });
});
