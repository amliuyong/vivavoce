'use client';
import React, { useId } from 'react';

/**
 * 表单字段封装(a11y):label 经 htmlFor 关联到控件,点击 label 聚焦输入、屏幕阅读器读出控件名。
 *
 * 用法:把 `<div className="field"><label>X</label><input .../></div>` 换成
 *   `<Field label="X"><input .../></Field>`
 * 组件用 useId 生成 id,注入到**单个** children 控件上(input/select/textarea);label htmlFor 指向它。
 * children 若已带 id 则尊重原 id(不覆盖)。保留 `.field` class → 既有 CSS 布局零变化。
 *
 * hint:可选字段说明(渲染为 .hint,通过 aria-describedby 关联)。
 */
export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactElement<{ id?: string; 'aria-describedby'?: string }>;
  className?: string;
}) {
  const autoId = useId();
  const controlId = children.props.id || autoId;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const control = React.cloneElement(children, {
    id: controlId,
    ...(hintId ? { 'aria-describedby': hintId } : {}),
  });
  return (
    <div className={className ? `field ${className}` : 'field'}>
      <label htmlFor={controlId}>{label}</label>
      {control}
      {hint ? (
        <div className="hint" id={hintId}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}
