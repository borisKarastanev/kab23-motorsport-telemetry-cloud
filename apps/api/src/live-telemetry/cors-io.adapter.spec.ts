import { INestApplicationContext } from '@nestjs/common';
import { CorsIoAdapter } from './cors-io.adapter';

describe('CorsIoAdapter', () => {
  it('applies the configured CORS options to the socket.io server', () => {
    const app = {} as INestApplicationContext;
    const cors = { origin: ['https://pitwall.example.test'] };
    const adapter = new CorsIoAdapter(app, cors);

    // `IoAdapter.createIOServer` builds the real socket.io server, which needs
    // more of a Nest app than this test wants to stand up. Only the merge of
    // `cors` into the options this class is responsible for is under test, so
    // the base implementation is stubbed to capture what it was called with.
    const createIOServerSpy = jest
      .spyOn(Object.getPrototypeOf(CorsIoAdapter.prototype), 'createIOServer')
      .mockReturnValue('server' as never);

    const result = adapter.createIOServer(3000, { path: '/live' } as never);

    expect(createIOServerSpy).toHaveBeenCalledWith(3000, {
      path: '/live',
      cors,
    });
    expect(result).toBe('server');

    createIOServerSpy.mockRestore();
  });

  it('sets cors even when no prior options were given', () => {
    const app = {} as INestApplicationContext;
    const cors = { origin: [] };
    const adapter = new CorsIoAdapter(app, cors);

    const createIOServerSpy = jest
      .spyOn(Object.getPrototypeOf(CorsIoAdapter.prototype), 'createIOServer')
      .mockReturnValue('server' as never);

    adapter.createIOServer(3000);

    expect(createIOServerSpy).toHaveBeenCalledWith(3000, { cors });

    createIOServerSpy.mockRestore();
  });
});
