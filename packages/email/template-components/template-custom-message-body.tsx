import React from 'react';

export type TemplateCustomMessageBodyProps = {
  text?: string;
  style?: React.CSSProperties;
};

export const TemplateCustomMessageBody = ({ text, style }: TemplateCustomMessageBodyProps) => {
  if (!text) {
    return null;
  }

  const normalized = text
    .trim()
    .replace(/\r\n?/g, '\n')
    .replace(/\n\s*\n+/g, '\n\n')
    .replace(/\n{2,}/g, '\n\n');

  const paragraphs = normalized.split('\n\n');

  return paragraphs.map((paragraph, i) => (
    <p
      key={`p-${i}`}
      className="whitespace-pre-line break-words font-sans text-base text-muted-foreground"
      style={style}
    >
      {paragraph.split('\n').map((line, j) => (
        <React.Fragment key={`line-${i}-${j}`}>
          {j > 0 && <br />}
          {line}
        </React.Fragment>
      ))}
    </p>
  ));
};

export default TemplateCustomMessageBody;
