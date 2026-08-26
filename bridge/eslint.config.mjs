// ESLint flat config (eslint 9 + typescript-eslint 8)。务实基线:js recommended + ts recommended
// (非 type-checked,快,不需类型信息)。重点防新问题,历史问题以 warn 不阻塞。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // 务实放宽:未用变量降为 warn 且允许 _ 前缀忽略;any 降 warn(媒体/SDK 交互处难免)
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // 测试文件更宽松
    files: ['test/**', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      // jest.resetModules() 后必须用 require() 重新加载模块实例(静态 import 被 hoist+缓存,拿不到新实例)
      '@typescript-eslint/no-require-imports': 'off',
      // 测试里的 async generator stub 可故意永不 yield(模拟"永不吐 token、只等 abort"的挂起 LLM 流)
      'require-yield': 'off',
    },
  },
);
