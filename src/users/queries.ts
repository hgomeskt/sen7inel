// src/users/queries.ts

interface User {
  id: string;
  name: string;
  email: string;
}

interface ProcessedUser {
  userId: string;
  displayName: string;
  contact: string;
}

export function getUser(id: string): User | null {
  // Simulates a database query that can return null
  if (id === "unknown") {
    return null;
  }
  return { id, name: "John Doe", email: "john@example.com" };
}

export function processUser(userId: string): ProcessedUser {
  const user = getUser(userId);

  if (user === null) {
    throw new Error(`User not found: ${userId}`);
  }

  return {
    userId: user.id,
    displayName: user.name,
    contact: user.email,
  };
}

export function handleRequest(userId: string): string {
  const processed = processUser(userId);
  return `User ${processed.userId}: ${processed.displayName} (${processed.contact})`;
}