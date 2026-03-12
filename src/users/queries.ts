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

  // Explicit null check with early return
  if (user === null || user === undefined) {
    throw new Error(`User not found or invalid: ${userId}`);
  }

  // Direct access to properties since null check passed
  const id = user.id;
  const name = user.name;
  const email = user.email;

  // Validate all required fields are present and valid
  if (!id || typeof id !== 'string' || id.trim() === '') {
    throw new Error(`User not found or invalid: ${userId}`);
  }
  
  if (!name || typeof name !== 'string' || name.trim() === '') {
    throw new Error(`User not found or invalid: ${userId}`);
  }
  
  if (!email || typeof email !== 'string' || email.trim() === '') {
    throw new Error(`User not found or invalid: ${userId}`);
  }

  return {
    userId: id,
    displayName: name,
    contact: email,
  };
}

export function handleRequest(userId: string): string {
  const processed = processUser(userId);
  return `User ${processed.userId}: ${processed.displayName} (${processed.contact})`;
}