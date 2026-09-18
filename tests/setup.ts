// Minimal env so config/env.ts validates during unit tests. The pure modules
// under test never open a socket; these values just satisfy the schema.
process.env.NODE_ENV = 'test';
process.env.APP_URL = 'http://localhost:3000';
process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.SESSION_SECRET = 's'.repeat(40);
process.env.UNSUBSCRIBE_SECRET = 'u'.repeat(40);
process.env.OPS_BASE_LAT = '30.0444';
process.env.OPS_BASE_LON = '31.2357';
