import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button, PageHeader } from '../components';

export function NotFoundPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <div className="page-stack page-stack--narrow">
      <PageHeader title={t('notFound.title')} />
      <section className="panel state-view">
        <p>{t('notFound.body')}</p>
        <Button variant="primary" onClick={() => navigate('/workspace')}>{t('actions.goWorkspace')}</Button>
      </section>
    </div>
  );
}
