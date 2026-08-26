import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'VivaVoce · 实时语音口试',
  description: '登录后直接与 AI 实时语音对话,完成考试 / 面试 / 口语练习 / 测评,产出结构化打分报告。',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
