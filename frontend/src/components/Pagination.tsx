import { useTranslation } from 'react-i18next';
import { Button } from './Button';

interface PaginationProps {
  page: number;
  totalPages: number;
  total: number;
  onPageChange: (page: number) => void;
  className?: string;
  disabled?: boolean;
}

export function Pagination({ page, totalPages, total, onPageChange, className = '', disabled = false }: PaginationProps) {
  const { t } = useTranslation();
  if (total === 0 || totalPages === 0) return null;
  return (
    <nav className={`pagination ${className}`.trim()} aria-label={t('pagination.label')}>
      <p>{t('pagination.summary', {
        page,
        totalPages,
        recordCount: t('pagination.recordCount', { count: total }),
      })}</p>
      <div>
        <Button variant="secondary" disabled={disabled || page <= 1} onClick={() => onPageChange(page - 1)}>
          {t('pagination.previous')}
        </Button>
        <Button variant="secondary" disabled={disabled || page >= totalPages} onClick={() => onPageChange(page + 1)}>
          {t('pagination.next')}
        </Button>
      </div>
    </nav>
  );
}
