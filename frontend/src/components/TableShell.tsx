import type { PropsWithChildren, ReactNode } from 'react';

export interface TableColumn {
  key: string;
  label: ReactNode;
  align?: 'left' | 'right';
}

interface TableShellProps extends PropsWithChildren {
  caption: ReactNode;
  columns: TableColumn[];
  busy?: boolean;
}

export function TableShell({ caption, columns, busy = false, children }: TableShellProps) {
  return (
    <div className="table-shell" aria-busy={busy || undefined}>
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map(column => (
              <th key={column.key} scope="col" className={column.align === 'right' ? 'is-numeric' : undefined}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
