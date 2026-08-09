import { Children, cloneElement, isValidElement, useId, type PropsWithChildren, type ReactNode, type ReactElement } from 'react';

interface FieldProps extends PropsWithChildren {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
}

function isFormControlElement(node: unknown): node is ReactElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean; 'aria-required'?: boolean; required?: boolean }> {
  return isValidElement(node) && typeof node.type === 'string' && ['input', 'select', 'textarea'].includes(node.type);
}

export function Field({ label, htmlFor, hint, error, required, className = '', children }: FieldProps) {
  const generatedId = useId();
  const childArray = Children.toArray(children);
  const firstControl = childArray.find(isFormControlElement);
  const controlId = htmlFor ?? firstControl?.props.id ?? generatedId;
  const hintId = hint ? `${generatedId}-hint` : undefined;
  const errorId = error ? `${generatedId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  let connected = false;
  const content = Children.map(children, child => {
    if (connected || !isFormControlElement(child)) return child;
    connected = true;
    const mergedDescribedBy = [...new Set(
      [child.props['aria-describedby'], describedBy]
        .filter(Boolean)
        .flatMap(value => String(value).split(/\s+/u)),
    )].join(' ') || undefined;
    const isRequired = required ?? child.props.required;
    return cloneElement(child, {
      id: controlId,
      required: isRequired,
      'aria-required': isRequired ? true : child.props['aria-required'],
      'aria-invalid': error ? true : child.props['aria-invalid'],
      'aria-describedby': mergedDescribedBy,
    });
  });

  return (
    <div className={`field ${className}`.trim()}>
      <label className="field__label" htmlFor={controlId}>
        {label}
        {required ? <span className="field__required" aria-hidden="true" /> : null}
      </label>
      {content}
      {hint ? <div id={hintId} className="field__hint">{hint}</div> : null}
      {error ? <div id={errorId} className="field__error" role="alert">{error}</div> : null}
    </div>
  );
}
