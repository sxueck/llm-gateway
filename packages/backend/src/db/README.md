# Database Layer Architecture

This directory contains the refactored database layer, organized by responsibility.

## Structure

```
src/db/
├── index.ts                    # Main entry point, exports all modules with backward compatibility
├── connection.ts              # Database connection pool management
├── schema.ts                  # Table schema definitions
├── migrations.ts              # Database migration logic
├── types.ts                   # Database-related TypeScript types
├── utils/                     # Utility functions
│   ├── buffer.ts              # API request buffering and batch writes
│   ├── time-buckets.ts        # Time bucket generation for analytics
│   └── string-utils.ts        # String truncation utilities
└── repositories/              # Data access layer (DAOs)
    ├── user.repository.ts
    ├── provider.repository.ts
    ├── model.repository.ts
    ├── virtual-key.repository.ts
    ├── system-config.repository.ts
    ├── api-request.repository.ts
    ├── routing-config.repository.ts
    ├── expert-routing-config.repository.ts
    ├── expert-routing-log.repository.ts
    ├── health-target.repository.ts
    └── health-run.repository.ts
```

## Key Modules

### connection.ts
Manages MySQL connection pool initialization, access, and shutdown.

**Exports:**
- `initDatabase()` - Initialize connection pool
- `getDatabase()` - Get connection pool instance
- `getPool()` - Alias for getDatabase
- `shutdownDatabase()` - Close all connections

### schema.ts
Contains SQL statements for creating all database tables.

**Exports:**
- `createTables()` - Create all tables if not exist

### types.ts
TypeScript type definitions for database entities.

**Exports:**
- `Model` - Model entity interface
- `HealthTarget` - Health monitoring target interface
- `HealthRun` - Health check run record interface
- `ApiRequestBuffer` - API request buffer type

### utils/buffer.ts
Implements buffered batch writes for API request logs to improve performance.

**Features:**
- In-memory buffer (max 200 records or 10 seconds)
- Automatic flushing on interval or size threshold
- String truncation to prevent MySQL errors
- Transaction-based batch inserts

**Exports:**
- `startBufferFlush()` - Start periodic flush timer
- `stopBufferFlush()` - Stop flush timer
- `flushApiRequestBuffer()` - Manually flush buffer
- `addToBuffer()` - Add request to buffer
- `getBufferSize()` - Get current buffer size
- `shouldFlush()` - Check if flush is needed

### utils/time-buckets.ts
Utilities for generating time buckets for trend analysis.

**Exports:**
- `generateTimeBuckets(startTime, endTime, intervalMs)` - Generate time points
- `initializeTimeBuckets(timePoints)` - Initialize empty buckets

### utils/string-utils.ts
String manipulation utilities for handling database column size limits.

**Exports:**
- `getByteLength(str)` - Calculate UTF-8 byte length
- `truncateToByteLength(str, maxBytes)` - Safely truncate string

## Repositories

Each repository follows a consistent pattern:

- **getAll()** - Retrieve all records
- **getById(id)** - Retrieve by primary key
- **create(data)** - Insert new record
- **update(id, updates)** - Update existing record
- **delete(id)** - Delete record

Some repositories have specialized methods:
- `apiRequestRepository.getStats()` - Aggregate statistics
- `apiRequestRepository.getTrend()` - Time-series data
- `healthTargetRepository.getDueTargets()` - Targets due for checking
- etc.

## Backward Compatibility

The main `index.ts` re-exports all modules with their original names:

```typescript
import { userDb, providerDb, modelDb } from './db/index.js';

// All existing code continues to work
const users = await userDb.getAll();
```

## Migration from Old Structure

The previous monolithic `index.ts` (1700+ lines) has been split into:

1. **Connection management** - Isolated in `connection.ts`
2. **Schema definition** - Extracted to `schema.ts`
3. **Data access** - Organized into `repositories/`
4. **Utilities** - Separated into `utils/`
5. **Types** - Centralized in `types.ts`

All exports remain the same, ensuring zero breaking changes for existing code.

## Benefits

1. **Single Responsibility** - Each file has one clear purpose
2. **Maintainability** - Easy to find and modify specific functionality
3. **Testability** - Each module can be tested independently
4. **Readability** - Smaller, focused files are easier to understand
5. **Scalability** - Easy to add new repositories or utilities
6. **No Breaking Changes** - Complete backward compatibility
