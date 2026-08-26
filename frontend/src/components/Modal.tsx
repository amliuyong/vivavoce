'use client';
import React from 'react';

export function Modal({
  title,
  onClose,
  children,
  footer,
  width,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}) {
  return (
    <div className="overlay show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={width ? { width } : undefined}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="close-x" onClick={onClose} aria-label="close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
