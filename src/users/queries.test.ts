// src/users/queries.test.ts

import { getUser, processUser, handleRequest } from './queries';

describe('users queries', () => {
  describe('getUser', () => {
    it('should return user when id exists', () => {
      const user = getUser('123');
      expect(user).toEqual({ id: '123', name: 'John Doe', email: 'john@example.com' });
    });

    it('should return null when id is unknown', () => {
      const user = getUser('unknown');
      expect(user).toBeNull();
    });
  });

  describe('processUser', () => {
    it('should process user when user exists', () => {
      const processed = processUser('123');
      expect(processed).toEqual({
        userId: '123',
        displayName: 'John Doe',
        contact: 'john@example.com',
      });
    });

    it('should throw error when user does not exist', () => {
      expect(() => processUser('unknown')).toThrow('User not found: unknown');
    });
  });

  describe('handleRequest', () => {
    it('should return formatted string for existing user', () => {
      const result = handleRequest('123');
      expect(result).toBe('User 123: John Doe (john@example.com)');
    });

    it('should throw error for unknown user', () => {
      expect(() => handleRequest('unknown')).toThrow('User not found: unknown');
    });
  });
});