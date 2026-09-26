import { redisConnection } from './jobs.constants.js';

describe('redisConnection', () => {
  it('reads host, port, credentials and database', () => {
    expect(redisConnection('redis://user:p%40ss@cache.internal:6380/2')).toMatchObject({ host: 'cache.internal', port: 6380, username: 'user', password: 'p@ss', db: 2, maxRetriesPerRequest: null });
  });

  it('keeps query options such as ?family=0 (IPv6 private networks)', () => {
    const c = redisConnection('redis://default:secret@redis.railway.internal:6379?family=0&connectTimeout=5000&connectionName=api');
    expect(c).toMatchObject({ host: 'redis.railway.internal', family: 0, connectTimeout: 5000, connectionName: 'api' });
    expect(c.maxRetriesPerRequest).toBeNull();
  });

  it('uses TLS for rediss:// and for ?tls=true, and strips IPv6 brackets', () => {
    expect(redisConnection('rediss://h:6379').tls).toEqual({});
    expect(redisConnection('redis://h:6379?tls=true').tls).toEqual({});
    expect(redisConnection('redis://[::1]:6379').host).toBe('::1');
  });
});
