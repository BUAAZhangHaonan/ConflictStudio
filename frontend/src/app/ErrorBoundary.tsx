import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/Button';

function ErrorBoundaryFallback({ onBackToWorkspace }: { onBackToWorkspace: () => void }) {
  const { t } = useTranslation();
  return (
    <section className="state-view" role="alert">
      <h2>{t('app.errorBoundary.title')}</h2>
      <p>{t('app.errorBoundary.body')}</p>
      <Button variant="secondary" onClick={onBackToWorkspace}>{t('actions.goWorkspace')}</Button>
    </section>
  );
}

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  private backToWorkspace = () => {
    this.setState({ error: null });
    window.location.assign('/workspace');
  };

  render() {
    if (this.state.error !== null) {
      return <ErrorBoundaryFallback onBackToWorkspace={this.backToWorkspace} />;
    }
    return this.props.children;
  }
}
