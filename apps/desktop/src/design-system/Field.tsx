import { cloneElement, isValidElement, useId, type ComponentProps, type ReactNode } from "react";
import { cx } from "./cx";
import styles from "./Field.module.css";

export type FieldControlProps = {
  id: string;
  required?: boolean;
  "aria-invalid"?: true;
  "aria-describedby"?: string;
};

export function Field({ id: suppliedId, label, description, error, required, children, className }: {
  id?: string;
  label: string;
  description?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: ReactNode | ((props: FieldControlProps) => ReactNode);
  className?: string;
}) {
  const generatedId = useId();
  const id = suppliedId ?? (isValidElement<FieldControlProps>(children) ? children.props.id : undefined) ?? generatedId;
  const describedBy = [description ? `${id}-description` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  const controlProps: FieldControlProps = { id, required, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy };
  const control = typeof children === "function" ? children(controlProps) : isValidElement<FieldControlProps>(children) ? cloneElement(children, { ...controlProps, "aria-describedby": [children.props["aria-describedby"], describedBy].filter(Boolean).join(" ") || undefined }) : children;
  return (
    <div className={cx(styles.field, className)}>
      <label className={styles.label} htmlFor={id}>{label}{required ? <span aria-hidden="true"> *</span> : null}</label>
      {control}
      {description ? <div className={styles.description} id={`${id}-description`}>{description}</div> : null}
      {error ? <div className={styles.error} id={`${id}-error`}>{error}</div> : null}
    </div>
  );
}

export type TextInputProps = ComponentProps<"input"> & { controlSize?: "sm" | "md" | "lg" };

export function TextInput({ className, controlSize = "md", ...props }: TextInputProps) {
  return <input {...props} data-size={controlSize} className={cx(styles.input, className)} />;
}

export type TextAreaProps = ComponentProps<"textarea"> & { editor?: boolean };

export function TextArea({ className, editor = false, ...props }: TextAreaProps) {
  return <textarea {...props} data-editor={editor || undefined} className={cx(styles.input, styles.textarea, className)} />;
}
