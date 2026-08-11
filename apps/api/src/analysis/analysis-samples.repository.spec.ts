import { DataSource } from 'typeorm';
import { AnalysisSamplesRepository } from './analysis-samples.repository';

describe('AnalysisSamplesRepository', () => {
  let dataSource: jest.Mocked<Partial<DataSource>>;
  let repository: AnalysisSamplesRepository;

  const from = new Date('2026-01-01T00:00:00Z');
  const to = new Date('2026-01-01T00:02:00Z');

  beforeEach(() => {
    dataSource = { query: jest.fn() };
    repository = new AnalysisSamplesRepository(
      dataSource as unknown as DataSource,
    );
  });

  describe('findRange', () => {
    it('queries the window in session/time order and returns the rows', async () => {
      const rows = [{ time: from, lat: 1, lon: 2 }];
      (dataSource.query as jest.Mock).mockResolvedValue(rows);

      await expect(repository.findRange('session-1', from, to)).resolves.toBe(
        rows,
      );
      expect(dataSource.query).toHaveBeenCalledWith(expect.any(String), [
        'session-1',
        from,
        to,
      ]);
      const [sql] = (dataSource.query as jest.Mock).mock.calls[0];
      expect(sql).toContain('ORDER BY time, seq');
    });
  });

  describe('findLapWindow', () => {
    it('brackets the window with the fix either side of it', async () => {
      const rows = [{ time: from, lat: 1, lon: 2 }];
      (dataSource.query as jest.Mock).mockResolvedValue(rows);

      await expect(
        repository.findLapWindow('session-1', from, to),
      ).resolves.toBe(rows);
      expect(dataSource.query).toHaveBeenCalledWith(expect.any(String), [
        'session-1',
        from,
        to,
      ]);
      const [sql] = (dataSource.query as jest.Mock).mock.calls[0];
      expect(sql).toContain('UNION ALL');
    });
  });

  describe('countRange', () => {
    it('returns the count from the first row', async () => {
      (dataSource.query as jest.Mock).mockResolvedValue([{ count: 42 }]);

      await expect(repository.countRange('session-1', from, to)).resolves.toBe(
        42,
      );
      expect(dataSource.query).toHaveBeenCalledWith(expect.any(String), [
        'session-1',
        from,
        to,
      ]);
    });
  });
});
