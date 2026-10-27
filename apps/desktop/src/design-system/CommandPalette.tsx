import { useRef, type ReactNode } from "react";
import { Command } from "cmdk";
import { Dialog } from "./Dialog";
import { Kbd } from "./Kbd";
import styles from "./CommandPalette.module.css";

export type PaletteCommand = {
  id: string;
  label: string;
  keywords?: string[];
  kbd?: ReactNode;
  disabled?: boolean;
  onSelect: () => void;
};
export type CommandGroup = { label: string; commands: PaletteCommand[] };

export function CommandPalette({ open, onOpenChange, title, placeholder, emptyLabel, closeLabel, groups }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  placeholder: string;
  emptyLabel: string;
  closeLabel: string;
  groups: CommandGroup[];
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} closeLabel={closeLabel} className={styles.dialog} onOpenAutoFocus={event => { event.preventDefault(); inputRef.current?.focus(); }}>
      <Command className={styles.command} label={title} onKeyDownCapture={event => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) event.stopPropagation();
      }}>
        <Command.Input ref={inputRef} className={styles.input} aria-label={placeholder} placeholder={placeholder} />
        <Command.List className={styles.list}>
          <Command.Empty className={styles.empty}>{emptyLabel}</Command.Empty>
          {groups.map(group => <Command.Group key={group.label} heading={group.label} className={styles.group}>
            {group.commands.map(command => <Command.Item key={command.id} value={command.id} keywords={[command.label, ...(command.keywords ?? [])]} disabled={command.disabled} className={styles.item} onSelect={() => { onOpenChange(false); command.onSelect(); }}>
              <span>{command.label}</span>{command.kbd ? <Kbd>{command.kbd}</Kbd> : null}
            </Command.Item>)}
          </Command.Group>)}
        </Command.List>
      </Command>
    </Dialog>
  );
}
