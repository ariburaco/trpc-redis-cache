import { MiddlewareResult } from '@trpc/server/unstable-core-do-not-import';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import {
  ConsoleLogger,
  RedisConnectionFactory,
  createConditionalLogger,
  getElapsedMs,
  safeStringify,
  sanitizeForCache,
} from './utils/index.js';
/**
 * Generic type for the tRPC context
 */
export interface TRPCContext {
  session:
    | {
        user?: {
          id?: string;
        };
      }
    | null
    | undefined;
  [key: string]: unknown;
}

/**
 * Cache configuration options
 */
export interface CacheConfig<TInput = unknown> {
  /**
   * Time to live in seconds, undefined means permanent
   * @default 60
   */
  ttl?: number;

  /**
   * Whether to use Upstash Redis instead of normal Redis
   * @default true
   */
  useUpstash?: boolean;

  /**
   * Whether to include user ID in cache key
   * @default true
   */
  userSpecific?: boolean;

  /**
   * If true, ignore user context for caching (global cache)
   * @default false
   */
  globalCache?: boolean;

  /**
   * Optional custom cache key function
   */
  getCacheKey?: (path: string, rawInput: TInput | undefined) => string;

  /**
   * Optional function to determine if the input should be cached
   * If provided and returns false, caching will be skipped entirely
   */
  shouldCache?: (input: TInput | undefined) => boolean;

  /**
   * Whether to log debug information
   * @default false
   */
  debug?: boolean;

  /**
   * Custom Redis URL for standard Redis (overrides env)
   */
  redisUrl?: string;

  /**
   * Custom Upstash Redis configuration (overrides env)
   */
  upstashConfig?: {
    url: string;
    token: string;
  };
}

/**
 * Default cache configuration
 */
const defaultCacheConfig: CacheConfig<unknown> = {
  ttl: 60, // 60 seconds default
  useUpstash: true,
  userSpecific: true,
  globalCache: false,
  debug: false,
};

// Create the logger
const loggerService = new ConsoleLogger('CacheMiddleware');

/**
 * Extract only the data portion from a tRPC response object
 * This prevents circular references in the context and other non-serializable parts
 */
function extractData(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;

  const { ctx, ...data } = result as { ctx: TRPCContext; data: unknown };

  return data;
}

/**
 * Create a cache key based on the procedure path, input, and context
 */
const createCacheKey = <TInput = unknown>(
  path: string,
  input: TInput | undefined,
  ctx: TRPCContext,
  config: CacheConfig<TInput>,
): string => {
  // Use custom cache key function if provided
  if (config.getCacheKey) {
    const customKey = config.getCacheKey(path, input);
    return customKey;
  }

  // Create default cache key based on configuration
  const inputString = input ? JSON.stringify(input) : '';

  // For global cache, don't include user info
  if (config.globalCache) {
    return `trpc:global:${path}:${inputString}`;
  }

  // For user-specific cache
  const userId = ctx.session?.user?.id ?? 'anonymous';

  if (config.userSpecific) {
    // Create a minimal context hash for user-specific caching
    return `trpc:user:${path}:${userId}:${inputString}`;
  }

  // Default case just uses the path and input
  return `trpc:${path}:${inputString}`;
};

// Validation schema for cache config
const cacheConfigSchema = z.object({
  ttl: z.number().positive().optional(),
  useUpstash: z.boolean().optional(),
  userSpecific: z.boolean().optional(),
  globalCache: z.boolean().optional(),
  getCacheKey: z.function().optional(),
  shouldCache: z.function().optional(),
  debug: z.boolean().optional(),
  redisUrl: z.string().optional(),
  upstashConfig: z
    .object({
      url: z.string(),
      token: z.string(),
    })
    .optional(),
});

/**
 * Create a cache middleware for a TRPC procedure
 * @param config - The cache configuration
 * @returns A middleware function that can be used to cache the result of a TRPC procedure
 *
 * @example
 * const globalCacheMiddleware = createCacheMiddleware({
 *   ttl: undefined, // Permanent cache
 *   useUpstash: false,
 *   globalCache: true, // Use global cache that's shared among all users
 *   userSpecific: false, // Don't include user ID in cache key
 * });
 *
 * @example
 * // With conditional caching based on input
 * const conditionalCacheMiddleware = createCacheMiddleware<MyContext, { query: string }>({
 *   ttl: 60,
 *   shouldCache: (input) => {
 *     // Only cache if query is not empty
 *     return input.query.length > 0;
 *   },
 * });
 *
 * const appRouter = createTRPCRouter({
 *   search: protectedProcedure
 *     .input(searchAppSchema)
 *     .use(conditionalCacheMiddleware)
 *     .query(async ({ input }) => {
 *      // Your query logic here
 *     }),
 * });
 */
export function createCacheMiddleware<
  TContext extends TRPCContext = TRPCContext,
  TInput = unknown,
>(config?: CacheConfig<TInput>) {
  const validatedConfig = {
    ...defaultCacheConfig,
    ...cacheConfigSchema.parse(config ?? {}),
  } as CacheConfig<TInput>;

  // Create a logger that respects the debug flag
  const logger = createConditionalLogger(loggerService, {
    debug: validatedConfig.debug,
  });

  return async ({
    ctx,
    path,
    next,
    input,
  }: {
    ctx: TContext;
    path: string;
    next: () => Promise<MiddlewareResult<object>>;
    input?: TInput;
  }) => {
    const startTime = performance.now();
    const userId = ctx.session?.user?.id ?? 'anonymous';
    const ttl = validatedConfig.ttl; // Can be undefined for permanent cache

    // Check if caching should be skipped based on input
    if (validatedConfig.shouldCache) {
      const shouldCache = validatedConfig.shouldCache(input);
      if (!shouldCache) {
        logger.info({
          message: 'Caching skipped due to shouldCache returning false',
          metadata: {
            userId,
            path,
            input,
          },
        });
        // Skip all caching logic and execute the procedure directly
        return await next();
      }
    }

    const cacheKey = createCacheKey(path, input, ctx, validatedConfig);

    try {
      if (validatedConfig.useUpstash) {
        const cacheStartTime = performance.now();
        const redis = validatedConfig.upstashConfig
          ? RedisConnectionFactory.getUpstashRedis(
              validatedConfig.upstashConfig,
            )
          : RedisConnectionFactory.getUpstashRedis();

        const cachedData = await redis.get(cacheKey);
        const cacheElapsedMs = getElapsedMs(cacheStartTime);

        if (cachedData) {
          logger.info({
            message: 'Cache hit',
            metadata: {
              userId,
              path,
              cacheKey,
              type: 'upstash',
              globalCache: validatedConfig.globalCache,
              userSpecific: validatedConfig.userSpecific,
              timing: {
                cacheRetrievalMs: cacheElapsedMs,
                totalMs: getElapsedMs(startTime),
              },
            },
          });
          // Successfully retrieved from cache
          return {
            ...cachedData,
            ctx,
          };
        }

        logger.info({
          message: 'Cache miss',
          metadata: {
            userId,
            path,
            cacheKey,
            type: 'upstash',
            globalCache: validatedConfig.globalCache,
            userSpecific: validatedConfig.userSpecific,
            timing: {
              cacheCheckMs: cacheElapsedMs,
            },
          },
        });

        const execStartTime = performance.now();
        const result = await next();
        const execElapsedMs = getElapsedMs(execStartTime);

        // Check if the result is is "ok"
        // If it's not ok, we don't want to cache the result
        // This is to prevent caching errors
        // We can't use the result.ok property because it's not typed
        // So we need to check if the result is an object and has an ok property
        // If it doesn't, we return the result without caching

        if (!result.ok) {
          logger.warn({
            message: 'Result is not ok. Result will not be cached.',
            metadata: {
              path,
            },
          });
          // Return the result without caching
          return result;
        }

        // Extract only the data portion of the result to avoid circular references
        const dataToCache = extractData(result);

        // Ensure we're not trying to cache circular references by using safe serialization first
        try {
          // First check if we can safely stringify it
          const safeData = safeStringify(dataToCache);
          if (!safeData) {
            logger.warn({
              message: 'Data could not be safely stringified for cache',
              metadata: {
                path,
                type: 'upstash',
              },
            });
            // Return the result without caching
            return result;
          }

          // If stringification succeeded, we know it's safe to cache
          const sanitizedData = sanitizeForCache(dataToCache);

          const cacheSetStartTime = performance.now();
          // Handle permanent caching (no TTL)
          if (ttl === undefined) {
            await redis.set(cacheKey, sanitizedData);
          } else {
            await redis.set(cacheKey, sanitizedData, { ex: ttl });
          }

          const cacheSetElapsedMs = getElapsedMs(cacheSetStartTime);

          logger.info({
            message: 'Cache set',
            metadata: {
              userId,
              path,
              cacheKey,
              ttl: ttl !== undefined ? ttl : 'permanent',
              type: 'upstash',
              globalCache: validatedConfig.globalCache,
              userSpecific: validatedConfig.userSpecific,
              timing: {
                executionMs: execElapsedMs,
                cacheSetMs: cacheSetElapsedMs,
                totalMs: getElapsedMs(startTime),
              },
            },
          });
        } catch (cacheError) {
          logger.error({
            message: 'Failed to set cache',
            metadata: {
              error:
                cacheError instanceof Error
                  ? cacheError.message
                  : String(cacheError),
              path,
              type: 'upstash',
            },
          });
        }

        return result;
      } else {
        const cacheStartTime = performance.now();
        const redis = await RedisConnectionFactory.getStandardRedis(
          validatedConfig.redisUrl,
        );

        const cachedData = await redis.get(cacheKey);
        const cacheElapsedMs = getElapsedMs(cacheStartTime);

        if (cachedData) {
          logger.info({
            message: 'Cache hit',
            metadata: {
              userId,
              path,
              cacheKey,
              type: 'redis',
              globalCache: validatedConfig.globalCache,
              userSpecific: validatedConfig.userSpecific,
              timing: {
                cacheRetrievalMs: cacheElapsedMs,
                totalMs: getElapsedMs(startTime),
              },
            },
          });
          // Parse the cached data and return it
          try {
            const parsedData = JSON.parse(cachedData);
            return {
              ...parsedData,
              ctx,
            };
          } catch (parseError) {
            // If parsing fails, log and return the raw value
            logger.warn({
              message: 'Failed to parse cached data',
              metadata: {
                error:
                  parseError instanceof Error
                    ? parseError.message
                    : String(parseError),
                path,
                type: 'redis',
              },
            });
            return cachedData;
          }
        }

        logger.info({
          message: 'Cache miss',
          metadata: {
            userId,
            path,
            cacheKey,
            type: 'redis',
            globalCache: validatedConfig.globalCache,
            userSpecific: validatedConfig.userSpecific,
            timing: {
              cacheCheckMs: cacheElapsedMs,
            },
          },
        });

        const execStartTime = performance.now();
        const result = await next();
        const execElapsedMs = getElapsedMs(execStartTime);

        // Check if the result is is "ok"
        // If it's not ok, we don't want to cache the result
        // This is to prevent caching errors
        // We can't use the result.ok property because it's not typed
        // So we need to check if the result is an object and has an ok property
        // If it doesn't, we return the result without caching
        if (!result.ok) {
          logger.warn({
            message: 'Result is not ok. Result will not be cached.',
            metadata: {
              path,
            },
          });
          return result;
        }

        // Extract only the data portion of the result to avoid circular references
        const dataToCache = extractData(result);

        // Try to safely serialize the data for caching
        try {
          // First check if we can safely stringify it
          const safeData = safeStringify(dataToCache);
          if (!safeData) {
            logger.warn({
              message: 'Data could not be safely stringified for cache',
              metadata: {
                path,
                type: 'redis',
              },
            });
            // Return the result without caching
            return result;
          }

          const cacheSetStartTime = performance.now();

          // Handle permanent caching (no TTL)
          if (ttl === undefined) {
            await redis.set(cacheKey, safeData);
          } else {
            await redis.setEx(cacheKey, ttl, safeData);
          }

          const cacheSetElapsedMs = getElapsedMs(cacheSetStartTime);

          logger.info({
            message: 'Cache set',
            metadata: {
              userId,
              path,
              cacheKey,
              ttl: ttl !== undefined ? ttl : 'permanent',
              type: 'redis',
              globalCache: validatedConfig.globalCache,
              userSpecific: validatedConfig.userSpecific,
              timing: {
                executionMs: execElapsedMs,
                cacheSetMs: cacheSetElapsedMs,
                totalMs: getElapsedMs(startTime),
              },
            },
          });
        } catch (cacheError) {
          logger.error({
            message: 'Failed to set cache',
            metadata: {
              error:
                cacheError instanceof Error
                  ? cacheError.message
                  : String(cacheError),
              path,
              type: 'redis',
            },
          });
        }

        return result;
      }
    } catch (error) {
      const errorElapsedMs = getElapsedMs(startTime);
      logger.error({
        message: 'Redis cache error',
        metadata: {
          error: error instanceof Error ? error.message : String(error),
          userId,
          path,
          cacheKey,
          type: validatedConfig.useUpstash ? 'upstash' : 'redis',
          timing: {
            errorMs: errorElapsedMs,
          },
        },
      });

      return next();
    }
  };
}

/**
 * Invalidate a cache entry for a specific procedure
 */
export async function invalidateCache(
  path: string,
  input?: unknown,
  options?: {
    useUpstash?: boolean;
    globalCache?: boolean;
    userSpecific?: boolean;
    userId?: string;
    redisUrl?: string;
    upstashConfig?: {
      url: string;
      token: string;
    };
  },
): Promise<void> {
  const defaultOptions = {
    useUpstash: true,
    globalCache: false,
    userSpecific: true,
  };

  const config = { ...defaultOptions, ...options };

  // Create a mock context with user ID if provided
  const mockCtx = {
    session: config.userId ? { user: { id: config.userId } } : undefined,
  } as TRPCContext;

  const cacheKey = createCacheKey(path, input, mockCtx, config);
  const logger = createConditionalLogger(loggerService);

  try {
    if (config.useUpstash) {
      const upstashRedis = config.upstashConfig
        ? RedisConnectionFactory.getUpstashRedis(config.upstashConfig)
        : RedisConnectionFactory.getUpstashRedis();

      await upstashRedis.del(cacheKey);

      logger.info({
        message: 'Cache invalidated',
        metadata: {
          path,
          cacheKey,
          type: 'upstash',
          globalCache: config.globalCache,
          userSpecific: config.userSpecific,
        },
      });
    } else {
      const redisClient = await RedisConnectionFactory.getStandardRedis(
        config.redisUrl,
      );

      await redisClient.del(cacheKey);

      logger.info({
        message: 'Cache invalidated',
        metadata: {
          path,
          cacheKey,
          type: 'redis',
          globalCache: config.globalCache,
          userSpecific: config.userSpecific,
        },
      });
    }
  } catch (error) {
    logger.error({
      message: 'Cache invalidation error',
      metadata: {
        error: error instanceof Error ? error.message : String(error),
        path,
        cacheKey,
        type: config.useUpstash ? 'upstash' : 'redis',
      },
    });
    throw error;
  }
}
