import type { ReactNode, Ref } from 'react';
import { useTranslation } from 'react-i18next';

interface MediaPanelProps {
  title: ReactNode;
  mediaLabel: string;
  src?: string;
  poster?: string;
  detail?: ReactNode;
  muted?: boolean;
  videoRef?: Ref<HTMLVideoElement>;
}

export function MediaPanel({ title, mediaLabel, src, poster, detail, muted = false, videoRef }: MediaPanelProps) {
  const { t } = useTranslation();
  return (
    <figure className="media-panel">
      <figcaption>{title}</figcaption>
      {src ? (
        <video ref={videoRef} controls preload="metadata" poster={poster} muted={muted} aria-label={mediaLabel}>
          <source src={src} />
          {t('media.videoNotSupported')}
        </video>
      ) : (
        <div className="media-panel__empty" role="img" aria-label={mediaLabel}>
          <span aria-hidden="true">▶</span>
          <p>{t('media.unavailable')}</p>
        </div>
      )}
      {detail ? <div className="media-panel__detail">{detail}</div> : null}
    </figure>
  );
}
