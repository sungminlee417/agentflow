"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Minimal styled markdown renderer for assistant messages. Uses
// Tailwind classes instead of @tailwindcss/typography so we don't need
// the plugin. Code blocks get a subtle background; inline code gets a
// thin pill.

export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => (
          <p className="my-2 leading-relaxed first:mt-0 last:mb-0">
            {children}
          </p>
        ),
        ul: ({ children }) => (
          <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>
        ),
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        h1: ({ children }) => (
          <h1 className="mt-4 mb-2 text-lg font-semibold">{children}</h1>
        ),
        h2: ({ children }) => (
          <h2 className="mt-4 mb-2 text-base font-semibold">{children}</h2>
        ),
        h3: ({ children }) => (
          <h3 className="mt-3 mb-2 text-sm font-semibold">{children}</h3>
        ),
        a: ({ children, href }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 underline underline-offset-2 hover:text-blue-500 dark:text-blue-400"
          >
            {children}
          </a>
        ),
        code: ({ children, className }) => {
          const isBlock = !!className;
          if (isBlock) {
            return (
              <code className={`${className} font-mono text-[12px]`}>
                {children}
              </code>
            );
          }
          return (
            <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[12px] text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200">
              {children}
            </code>
          );
        },
        pre: ({ children }) => (
          <pre className="my-3 overflow-x-auto rounded-md bg-neutral-100 p-3 text-[12px] leading-relaxed dark:bg-neutral-900">
            {children}
          </pre>
        ),
        blockquote: ({ children }) => (
          <blockquote className="my-2 border-l-2 border-neutral-300 pl-3 text-neutral-700 italic dark:border-neutral-700 dark:text-neutral-300">
            {children}
          </blockquote>
        ),
        hr: () => (
          <hr className="my-4 border-neutral-200 dark:border-neutral-800" />
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
