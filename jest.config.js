module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/unit/**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', '/.worktrees/'],
  clearMocks: true
};
