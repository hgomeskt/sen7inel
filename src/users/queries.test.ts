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
      expect(() => processUser('unknown')).toThrow('User not found or invalid: unknown');
    });

    it('should handle null user gracefully', () => {
      // Mock getUser to return null for this test
      const originalGetUser = require('./queries').getUser;
      const queries = require('./queries');
      queries.getUser = jest.fn().mockReturnValue(null);

      expect(() => processUser('test-null')).toThrow('User not found or invalid: test-null');

      // Restore original function
      queries.getUser = originalGetUser;
    });

    it('should handle undefined user gracefully', () => {
      // Mock getUser to return undefined for this test
      const originalGetUser = require('./queries').getUser;
      const queries = require('./queries');
      queries.getUser = jest.fn().mockReturnValue(undefined);

      expect(() => processUser('test-undefined')).toThrow('User not found or invalid: test-undefined');

      // Restore original function
      queries.getUser = originalGetUser;
    });
  });

  describe('handleRequest', () => {
    it('should return formatted string for existing user', () => {
      const result = handleRequest('123');
      expect(result).toBe('User 123: John Doe (john@example.com)');
    });

    it('should throw error for unknown user', () => {
      expect(() => handleRequest('unknown')).toThrow('User not found or invalid: unknown');
    });
  });
});