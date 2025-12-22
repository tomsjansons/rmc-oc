# Development Agents Contract

## Core Principles

**No Comments Policy**  
All code must be self-documenting. Function and variable names must clearly
express intent.  
Complex logic requires decomposition into smaller, well-named functions rather
than comments.

**Strict Linting Enforcement**  
All code must pass linting checks before commit.  
CI/CD will reject any code that fails linting standards.


**No Dead Code**
There should not be any obsolete/dead/unreabable code (functions, classes, etc) that are 
left from previous iterations or refactors. Also additional utility function or helpers or 
unused exported functions should never be created if they are not immediately used elsewhere in the codebase.

Placeholder functions are allowed for high level planning/wiring but they must never
contain actual logic, but always just the signature 
and `throw Error("TODO: implement in Phase X")` according to the project plan

## TypeScript Development

### 1. Prefer `type` over `interface`

Use `type` aliases instead of `interface` for most type definitions. `type` is more flexible as it can represent primitives, unions, tuples, and other types in addition to object shapes.

#### Good Examples:
```typescript
// Primitives
type UserId = string;

// Union types
type Status = 'active' | 'inactive' | 'pending';

// Object shapes
type User = {
  id: UserId;
  name: string;
};
```

#### Bad Examples:
```typescript
// Don't use interface for primitives
interface UserId extends string {}  // Error

// Don't use interface for union types
interface Status { 
  value: 'active' | 'inactive' | 'pending'; 
}

// Unnecessary interface for simple object shapes
interface User {
  id: UserId;
  name: string;
}
```

#### When to Use `interface`

Only use `interface` when you specifically need its features:
- Declaration merging
- Implementing classes
- Extending existing interfaces

```typescript
// Declaration merging
interface Window {
  myCustomProperty: string;
}

// Implementing classes
interface Logger {
  log(message: string): void;
}
```

### 2. Control Flows Must Always Use Curly Braces

Always wrap control flow bodies in curly braces, even for single statements. This prevents errors when modifying code and improves readability.

#### Good Examples:
```typescript
if (!isOk) {
  return false;
}

for (let i = 0; i < items.length; i++) {
  processItem(items[i]);
}

while (condition) {
  doSomething();
}
```

#### Bad Examples:
```typescript
// Dangerous - don't do this
if (!isOk) return false;

for (let i = 0; i < items.length; i++) processItem(items[i]);

while (condition) doSomething();
```

### 3. Avoid Casting Through `unknown`

Never cast values through `unknown` as it bypasses TypeScript's type safety. Instead, use proper validation, type guards, or assertion libraries.

#### Good Examples:
```typescript
// Type guard function
function isUser(obj: any): obj is User {
  return (
    typeof obj === 'object' && 
    obj !== null && 
    typeof obj.name === 'string'
  );
}

// Runtime validation with Zod
import { z } from 'zod';
const UserSchema = z.object({ name: z.string() });
const user = UserSchema.parse(data); // Throws if invalid

// Direct assertion (when certain)
const element = document.getElementById('myId') as HTMLDivElement;
```

#### Bad Examples:
```typescript
// Never cast through unknown
const user = data as unknown as User;

// Bypasses all type checking
const element = document.getElementById('myId') as unknown as HTMLDivElement;
```

## Testing Principles

Follow these core principles when writing tests:

### Test Meaningful Logic, Not Trivial Orchestration

Focus your testing efforts on methods that contain meaningful business logic
rather than boilerplate orchestration:

**Test These:**

- Calculation methods that process input and return computed results
- Transformation methods that convert data from one format to another
- Combination methods that merge multiple inputs into a single output
- Validation methods that determine correctness of data or state

**Avoid Testing These:**

- Simple factory methods that just instantiate objects
- Orchestration methods that merely call other methods in sequence
- Looping constructs that don't modify data (e.g., iterating to call a method on
  each item)
- Getter/setter methods that directly access properties without logic

### Implementation Guidelines

1. **Input-Output Focus**: Test methods based on their input-output behavior
   rather than internal implementation details
2. **Edge Case Coverage**: Prioritize testing boundary conditions and error
   cases over happy-path repetition
3. **Mock External Dependencies**: Use mocks for external services, databases,
   or file systems to keep tests fast and reliable
4. **Test at the Right Level**: Write unit tests for individual methods and
   integration tests for component interactions
