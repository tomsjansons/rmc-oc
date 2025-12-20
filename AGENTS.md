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

- Prefer `type` over `interface`
- Control flows must always be wrapped in curly braces - no single line ifs or
  loops (`if (!ok) return`)

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
