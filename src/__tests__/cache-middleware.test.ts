import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RedisConnectionFactory } from '../utils/redis-connection.js';
import { createCacheMiddleware, invalidateCache } from '../cache-middleware.js';
import {
  MockRedisClient,
  MockUpstashRedis,
  createMockContext,
  createMockNext,
  createMockFailingNext,
  silentLogger,
} from './test-utils.js';

describe('Cache Middleware', () => {
  const mockStandardRedis = new MockRedisClient();
  const mockUpstashRedis = new MockUpstashRedis();

  // Set up mocks
  beforeEach(() => {
    // Set up Redis connection factory mocks
    vi.spyOn(RedisConnectionFactory, 'getStandardRedis').mockImplementation(
      async () => mockStandardRedis as any,
    );

    vi.spyOn(RedisConnectionFactory, 'getUpstashRedis').mockImplementation(
      () => mockUpstashRedis as any,
    );

    // Set logger to silent for tests
    RedisConnectionFactory.setLogger(silentLogger);

    // Reset mock storage
    mockStandardRedis.clear();
    mockUpstashRedis.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const DEBUG = true;

  describe('createCacheMiddleware', () => {
    it('should cache the result of a procedure using Upstash Redis', async () => {
      const middleware = createCacheMiddleware({
        useUpstash: true,
        debug: DEBUG,
      });

      const mockData = { id: 1, name: 'Test' };
      const mockResult = {
        ok: true,
        marker: 'middlewareMarker',
        error: null,
        data: mockData,
      };

      const { next, getCallCount } = createMockNext(mockData);
      const ctx = createMockContext('user-1');
      // First call should miss cache and execute the procedure
      const result1 = await middleware({
        ctx,
        path: 'test.procedure',
        next,
        input: { query: 'test' },
      });

      expect(result1).toEqual(mockResult);
      expect(getCallCount()).toBe(1);

      // Second call should hit cache and not execute the procedure again
      const result2 = await middleware({
        ctx,
        path: 'test.procedure',
        next,
        input: { query: 'test' },
      });

      expect(result2).toEqual({
        ...mockResult,
        ctx,
      });
      expect(getCallCount()).toBe(1); // Still 1, not 2

      // Different user should miss cache
      const result3 = await middleware({
        ctx: createMockContext('user-2'),
        path: 'test.procedure',
        next,
        input: { query: 'test' },
      });

      expect(result3).toEqual(mockResult);
      expect(getCallCount()).toBe(2);
    });

    it('should cache the result of a procedure using standard Redis', async () => {
      const middleware = createCacheMiddleware({
        useUpstash: false,
        debug: DEBUG,
      });

      const mockData = { id: 1, name: 'Test' };
      const mockResult = {
        ok: true,
        marker: 'middlewareMarker',
        error: null,
        data: mockData,
      };
      const { next, getCallCount } = createMockNext(mockData);

      // First call should miss cache and execute the procedure
      const result1 = await middleware({
        ctx: createMockContext('user-1'),
        path: 'test.procedure',
        next,
        input: { query: 'test' },
      });

      expect(result1).toEqual(mockResult);
      expect(getCallCount()).toBe(1);

      // Second call should hit cache and not execute the procedure again
      const result2 = await middleware({
        ctx: createMockContext('user-1'),
        path: 'test.procedure',
        next,
        input: { query: 'test' },
      });

      expect(result2).toEqual({
        ...mockResult,
        ctx: createMockContext('user-1'),
      });
      expect(getCallCount()).toBe(1); // Still 1, not 2
    });

    it('should use global cache when globalCache is true', async () => {
      const middleware = createCacheMiddleware({
        useUpstash: true,
        globalCache: true,
        userSpecific: false,
        debug: DEBUG,
      });

      const mockData = { id: 1, name: 'Test' };
      const mockResult = {
        ok: true,
        marker: 'middlewareMarker',
        error: null,
        data: mockData,
      };

      const { next, getCallCount } = createMockNext(mockData);

      // First call should miss cache and execute the procedure
      await middleware({
        ctx: createMockContext('user-1'),
        path: 'test.procedure',
        next,
        input: { query: 'test' },
      });

      expect(getCallCount()).toBe(1);

      // Different user should hit cache with global cache enabled
      await middleware({
        ctx: createMockContext('user-2'),
        path: 'test.procedure',
        next,
        input: { query: 'test' },
      });

      expect(getCallCount()).toBe(1); // Still 1, not 2
    });

    it('should use custom cache key function when provided', async () => {
      const customCacheKey = (path: string, input: unknown) => {
        return `custom:${path}:${JSON.stringify(input)}`;
      };

      const middleware = createCacheMiddleware({
        useUpstash: true,
        getCacheKey: customCacheKey,
        debug: DEBUG,
      });

      const mockData = { id: 1, name: 'Test' };
      const mockResult = {
        ok: true,
        marker: 'middlewareMarker',
        error: null,
        data: mockData,
      };
      const { next, getCallCount } = createMockNext(mockData);

      // First call should miss cache and execute the procedure
      await middleware({
        ctx: createMockContext('user-1'),
        path: 'test.procedure',
        next,
        input: { query: 'test' },
      });

      expect(getCallCount()).toBe(1);

      // Check that our custom key is used
      const cacheEntries = mockUpstashRedis.getAll();
      expect(Object.keys(cacheEntries)[0]).toContain('custom:');
    });

    it('should handle Redis errors gracefully', async () => {
      vi.spyOn(RedisConnectionFactory, 'getUpstashRedis').mockImplementation(
        () => {
          throw new Error('Redis connection failed');
        },
      );

      const middleware = createCacheMiddleware({
        useUpstash: true,
        debug: DEBUG,
      });

      const mockData = { id: 1, name: 'Test' };
      const mockResult = {
        ok: true,
        marker: 'middlewareMarker',
        error: null,
        data: mockData,
      };

      const { next, getCallCount } = createMockNext(mockData);

      // Should execute the procedure even if Redis fails
      const result = await middleware({
        ctx: createMockContext('user-1'),
        path: 'test.procedure',
        next,
        input: { query: 'test' },
      });

      expect(result).toEqual(mockResult);
      expect(getCallCount()).toBe(1);
    });

    it('should not cache failed procedure results with Upstash Redis', async () => {
      const middleware = createCacheMiddleware({
        useUpstash: true,
        debug: DEBUG,
      });

      const { next, getCallCount } = createMockFailingNext();
      const ctx = createMockContext('user-1');

      // First call should execute and not cache the error
      const result1 = await middleware({
        ctx,
        path: 'test.procedure',
        next,
        input: { query: 'test' },
      });

      expect(result1).toEqual({
        ok: false,
        marker: 'middlewareMarker',
        data: null,
        error: expect.objectContaining({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Test error',
        }),
      });
      expect(getCallCount()).toBe(1);

      // Second call should also execute (not use cache)
      const result2 = await middleware({
        ctx,
        path: 'test.procedure',
        next,
        input: { query: 'test' },
      });

      expect(result2).toEqual({
        ok: false,
        marker: 'middlewareMarker',
        data: null,
        error: expect.objectContaining({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Test error',
        }),
      });
      expect(getCallCount()).toBe(2); // Should increment because error wasn't cached

      // Verify no cache entries were created
      const cacheEntries = mockUpstashRedis.getAll();
      expect(Object.keys(cacheEntries).length).toBe(0);
    });

    it('should not cache failed procedure results with standard Redis', async () => {
      const middleware = createCacheMiddleware({
        useUpstash: false,
        debug: DEBUG,
      });

      const { next, getCallCount } = createMockFailingNext();
      const ctx = createMockContext('user-1');

      // First call should execute and not cache the error
      const result1 = await middleware({
        ctx,
        path: 'test.procedure',
        next,
        input: { query: 'test' },
      });

      expect(result1).toEqual({
        ok: false,
        marker: 'middlewareMarker',
        data: null,
        error: expect.objectContaining({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Test error',
        }),
      });
      expect(getCallCount()).toBe(1);

      // Second call should also execute (not use cache)
      const result2 = await middleware({
        ctx,
        path: 'test.procedure',
        next,
        input: { query: 'test' },
      });

      expect(result2).toEqual({
        ok: false,
        marker: 'middlewareMarker',
        data: null,
        error: expect.objectContaining({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Test error',
        }),
      });
      expect(getCallCount()).toBe(2); // Should increment because error wasn't cached

      // Verify no cache entries were created
      const cacheEntries = mockStandardRedis.getAll();
      expect(Object.keys(cacheEntries).length).toBe(0);
    });

    it('should handle transition from error to success correctly', async () => {
      const middleware = createCacheMiddleware({
        useUpstash: true,
        debug: DEBUG,
      });

      const { next: failingNext, getCallCount: getFailCount } =
        createMockFailingNext();
      const { next: successNext, getCallCount: getSuccessCount } =
        createMockNext({ id: 1, name: 'Test' });

      const ctx = createMockContext('user-1');
      const input = { query: 'test' };

      // First call with error
      const result1 = await middleware({
        ctx,
        path: 'test.procedure',
        next: failingNext,
        input,
      });

      expect(result1.ok).toBe(false);
      expect(getFailCount()).toBe(1);

      // Second call with success should work and be cached
      const result2 = await middleware({
        ctx,
        path: 'test.procedure',
        next: successNext,
        input,
      });

      expect(result2.ok).toBe(true);
      expect(result2.data).toEqual({ id: 1, name: 'Test' });
      expect(getSuccessCount()).toBe(1);

      // Third call should use cached success result
      const result3 = await middleware({
        ctx,
        path: 'test.procedure',
        next: successNext,
        input,
      });

      expect(result3.ok).toBe(true);
      expect(result3.data).toEqual({ id: 1, name: 'Test' });
      expect(getSuccessCount()).toBe(1); // Still 1, used cache
    });

    describe('shouldCache', () => {
      it('should skip caching when shouldCache returns false with Upstash Redis', async () => {
        const middleware = createCacheMiddleware<ReturnType<typeof createMockContext>, { query: string }>({
          useUpstash: true,
          debug: DEBUG,
          shouldCache: (input) => {
            // Only cache if query is not empty
            return (input?.query?.length ?? 0) > 0;
          },
        });

        const mockData = { id: 1, name: 'Test' };
        const mockResult = {
          ok: true,
          marker: 'middlewareMarker',
          error: null,
          data: mockData,
        };

        const { next, getCallCount } = createMockNext(mockData);
        const ctx = createMockContext('user-1');

        // First call with empty query - should not cache
        const result1 = await middleware({
          ctx,
          path: 'test.procedure',
          next,
          input: { query: '' },
        });

        expect(result1).toEqual(mockResult);
        expect(getCallCount()).toBe(1);

        // Verify no cache entry was created
        const cacheEntries = mockUpstashRedis.getAll();
        expect(Object.keys(cacheEntries).length).toBe(0);

        // Second call with empty query - should execute again (not cached)
        const result2 = await middleware({
          ctx,
          path: 'test.procedure',
          next,
          input: { query: '' },
        });

        expect(result2).toEqual(mockResult);
        expect(getCallCount()).toBe(2); // Should increment because not cached

        // Third call with non-empty query - should cache
        const result3 = await middleware({
          ctx,
          path: 'test.procedure',
          next,
          input: { query: 'test' },
        });

        expect(result3).toEqual(mockResult);
        expect(getCallCount()).toBe(3);

        // Verify cache entry was created for non-empty query
        const cacheEntriesAfter = mockUpstashRedis.getAll();
        expect(Object.keys(cacheEntriesAfter).length).toBe(1);

        // Fourth call with same non-empty query - should use cache
        const result4 = await middleware({
          ctx,
          path: 'test.procedure',
          next,
          input: { query: 'test' },
        });

        expect(result4).toEqual({
          ...mockResult,
          ctx,
        });
        expect(getCallCount()).toBe(3); // Still 3, used cache
      });

      it('should skip caching when shouldCache returns false with standard Redis', async () => {
        const middleware = createCacheMiddleware<ReturnType<typeof createMockContext>, { query: string }>({
          useUpstash: false,
          debug: DEBUG,
          shouldCache: (input) => {
            return (input?.query?.length ?? 0) > 0;
          },
        });

        const mockData = { id: 1, name: 'Test' };
        const mockResult = {
          ok: true,
          marker: 'middlewareMarker',
          error: null,
          data: mockData,
        };

        const { next, getCallCount } = createMockNext(mockData);
        const ctx = createMockContext('user-1');

        // First call with empty query - should not cache
        await middleware({
          ctx,
          path: 'test.procedure',
          next,
          input: { query: '' },
        });

        expect(getCallCount()).toBe(1);

        // Verify no cache entry was created
        const cacheEntries = mockStandardRedis.getAll();
        expect(Object.keys(cacheEntries).length).toBe(0);

        // Second call with empty query - should execute again
        await middleware({
          ctx,
          path: 'test.procedure',
          next,
          input: { query: '' },
        });

        expect(getCallCount()).toBe(2); // Should increment because not cached
      });

      it('should cache when shouldCache returns true', async () => {
        const middleware = createCacheMiddleware<ReturnType<typeof createMockContext>, { query: string }>({
          useUpstash: true,
          debug: DEBUG,
          shouldCache: (input) => {
            return (input?.query?.length ?? 0) > 0;
          },
        });

        const mockData = { id: 1, name: 'Test' };
        const mockResult = {
          ok: true,
          marker: 'middlewareMarker',
          error: null,
          data: mockData,
        };

        const { next, getCallCount } = createMockNext(mockData);
        const ctx = createMockContext('user-1');

        // First call with non-empty query - should cache
        const result1 = await middleware({
          ctx,
          path: 'test.procedure',
          next,
          input: { query: 'test' },
        });

        expect(result1).toEqual(mockResult);
        expect(getCallCount()).toBe(1);

        // Verify cache entry was created
        const cacheEntries = mockUpstashRedis.getAll();
        expect(Object.keys(cacheEntries).length).toBe(1);

        // Second call with same input - should use cache
        const result2 = await middleware({
          ctx,
          path: 'test.procedure',
          next,
          input: { query: 'test' },
        });

        expect(result2).toEqual({
          ...mockResult,
          ctx,
        });
        expect(getCallCount()).toBe(1); // Still 1, used cache
      });

      it('should work correctly when shouldCache is not provided (backward compatibility)', async () => {
        const middleware = createCacheMiddleware({
          useUpstash: true,
          debug: DEBUG,
          // shouldCache is not provided
        });

        const mockData = { id: 1, name: 'Test' };
        const mockResult = {
          ok: true,
          marker: 'middlewareMarker',
          error: null,
          data: mockData,
        };

        const { next, getCallCount } = createMockNext(mockData);
        const ctx = createMockContext('user-1');

        // First call should cache normally
        const result1 = await middleware({
          ctx,
          path: 'test.procedure',
          next,
          input: { query: 'test' },
        });

        expect(result1).toEqual(mockResult);
        expect(getCallCount()).toBe(1);

        // Second call should use cache
        const result2 = await middleware({
          ctx,
          path: 'test.procedure',
          next,
          input: { query: 'test' },
        });

        expect(result2).toEqual({
          ...mockResult,
          ctx,
        });
        expect(getCallCount()).toBe(1); // Still 1, used cache
      });

      it('should handle shouldCache with undefined input', async () => {
        const middleware = createCacheMiddleware<ReturnType<typeof createMockContext>, { query?: string }>({
          useUpstash: true,
          debug: DEBUG,
          shouldCache: (input) => {
            // Cache if input exists and has query
            return input !== undefined && input.query !== undefined;
          },
        });

        const mockData = { id: 1, name: 'Test' };
        const mockResult = {
          ok: true,
          marker: 'middlewareMarker',
          error: null,
          data: mockData,
        };

        const { next, getCallCount } = createMockNext(mockData);
        const ctx = createMockContext('user-1');

        // Call with undefined input - should not cache
        const result1 = await middleware({
          ctx,
          path: 'test.procedure',
          next,
          input: undefined,
        });

        expect(result1).toEqual(mockResult);
        expect(getCallCount()).toBe(1);

        // Verify no cache entry was created
        const cacheEntries = mockUpstashRedis.getAll();
        expect(Object.keys(cacheEntries).length).toBe(0);

        // Second call with undefined - should execute again
        const result2 = await middleware({
          ctx,
          path: 'test.procedure',
          next,
          input: undefined,
        });

        expect(result2).toEqual(mockResult);
        expect(getCallCount()).toBe(2); // Should increment because not cached
      });

      it('should handle complex shouldCache logic with multiple conditions', async () => {
        interface SearchInput {
          query: string;
          filters?: {
            category?: string;
            minPrice?: number;
          };
        }

        const middleware = createCacheMiddleware<ReturnType<typeof createMockContext>, SearchInput>({
          useUpstash: true,
          debug: DEBUG,
          shouldCache: (input) => {
            // Only cache if query is not empty AND no filters are applied
            return (
              input !== undefined &&
              input.query.length > 0 &&
              (!input.filters ||
                (!input.filters.category && !input.filters.minPrice))
            );
          },
        });

        const mockData = { id: 1, name: 'Test' };
        const mockResult = {
          ok: true,
          marker: 'middlewareMarker',
          error: null,
          data: mockData,
        };

        const { next, getCallCount } = createMockNext(mockData);
        const ctx = createMockContext('user-1');

        // Call with query but no filters - should cache
        const result1 = await middleware({
          ctx,
          path: 'test.procedure',
          next,
          input: { query: 'test' },
        });

        expect(result1).toEqual(mockResult);
        expect(getCallCount()).toBe(1);

        // Verify cache entry was created
        const cacheEntries1 = mockUpstashRedis.getAll();
        expect(Object.keys(cacheEntries1).length).toBe(1);

        // Call with query and filters - should not cache
        const result2 = await middleware({
          ctx,
          path: 'test.procedure',
          next,
          input: { query: 'test', filters: { category: 'electronics' } },
        });

        expect(result2).toEqual(mockResult);
        expect(getCallCount()).toBe(2);

        // Verify no new cache entry was created (still only 1)
        const cacheEntries2 = mockUpstashRedis.getAll();
        expect(Object.keys(cacheEntries2).length).toBe(1);

        // Call with same query and no filters - should use cache
        const result3 = await middleware({
          ctx,
          path: 'test.procedure',
          next,
          input: { query: 'test' },
        });

        expect(result3).toEqual({
          ...mockResult,
          ctx,
        });
        expect(getCallCount()).toBe(2); // Still 2, used cache
      });

      it('should not cache errors even when shouldCache returns true', async () => {
        const middleware = createCacheMiddleware<ReturnType<typeof createMockContext>, { query: string }>({
          useUpstash: true,
          debug: DEBUG,
          shouldCache: () => true, // Always return true
        });

        const { next, getCallCount } = createMockFailingNext();
        const ctx = createMockContext('user-1');

        // First call with error - should not cache even though shouldCache returns true
        const result1 = await middleware({
          ctx,
          path: 'test.procedure',
          next,
          input: { query: 'test' },
        });

        expect(result1.ok).toBe(false);
        expect(getCallCount()).toBe(1);

        // Verify no cache entry was created (errors are never cached)
        const cacheEntries = mockUpstashRedis.getAll();
        expect(Object.keys(cacheEntries).length).toBe(0);

        // Second call should also execute (not use cache)
        const result2 = await middleware({
          ctx,
          path: 'test.procedure',
          next,
          input: { query: 'test' },
        });

        expect(result2.ok).toBe(false);
        expect(getCallCount()).toBe(2); // Should increment because error wasn't cached
      });
    });
  });

  describe('invalidateCache', () => {
    it('should invalidate Upstash Redis cache for a specific procedure', async () => {
      const middleware = createCacheMiddleware({
        useUpstash: true,
        debug: DEBUG,
      });

      const mockData = { id: 1, name: 'Test' };
      const mockResult = {
        ok: true,
        marker: 'middlewareMarker',
        error: null,
        data: mockData,
      };

      const { next, getCallCount } = createMockNext(mockData);

      // Cache the result
      await middleware({
        ctx: createMockContext('user-1'),
        path: 'test.procedure',
        next,
        input: { query: 'test' },
      });

      expect(getCallCount()).toBe(1);

      // Verify cache entry exists
      const cacheEntries = mockUpstashRedis.getAll();
      expect(Object.keys(cacheEntries).length).toBe(1);

      // Invalidate the cache
      await invalidateCache(
        'test.procedure',
        { query: 'test' },
        {
          useUpstash: true,
          userId: 'user-1',
        },
      );

      // Verify cache entry is removed
      const cacheEntriesAfter = mockUpstashRedis.getAll();
      expect(Object.keys(cacheEntriesAfter).length).toBe(0);

      // Next call should miss cache
      await middleware({
        ctx: createMockContext('user-1'),
        path: 'test.procedure',
        next,
        input: { query: 'test' },
      });

      expect(getCallCount()).toBe(2);
    });

    it('should invalidate standard Redis cache for a specific procedure', async () => {
      const middleware = createCacheMiddleware({
        useUpstash: false,
        debug: DEBUG,
      });

      const mockData = { id: 1, name: 'Test' };
      const { next, getCallCount } = createMockNext(mockData);

      // Cache the result
      await middleware({
        ctx: createMockContext('user-1'),
        path: 'test.procedure',
        next,
        input: { query: 'test' },
      });

      expect(getCallCount()).toBe(1);

      // Verify cache entry exists
      const cacheEntries = mockStandardRedis.getAll();
      expect(Object.keys(cacheEntries).length).toBe(1);

      // Invalidate the cache
      await invalidateCache(
        'test.procedure',
        { query: 'test' },
        {
          useUpstash: false,
          userId: 'user-1',
        },
      );

      // Verify cache entry is removed
      const cacheEntriesAfter = mockStandardRedis.getAll();
      expect(Object.keys(cacheEntriesAfter).length).toBe(0);

      // Next call should miss cache
      await middleware({
        ctx: createMockContext('user-1'),
        path: 'test.procedure',
        next,
        input: { query: 'test' },
      });

      expect(getCallCount()).toBe(2);
    });
  });
});
