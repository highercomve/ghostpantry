import { useState, type ComponentProps } from "react";

type Props = Omit<
  ComponentProps<"input">,
  "type" | "value" | "defaultValue" | "onChange"
> & {
  value: number;
  onValueChange: (value: number) => void;
};

/** Keep the text being edited separate from the saved numeric value. */
export function NumberInput({
  value,
  onValueChange,
  onFocus,
  onBlur,
  ...props
}: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      {...props}
      type="number"
      inputMode="decimal"
      value={draft ?? value}
      onFocus={(event) => {
        setDraft(event.currentTarget.value);
        onFocus?.(event);
      }}
      onChange={(event) => {
        setDraft(event.currentTarget.value);
        const number = event.currentTarget.valueAsNumber;
        if (
          Number.isFinite(number) &&
          !event.currentTarget.validity.rangeUnderflow &&
          !event.currentTarget.validity.rangeOverflow
        ) {
          onValueChange(number);
        }
      }}
      onBlur={(event) => {
        // An unfinished/empty edit restores the last valid value on leaving the field.
        setDraft(null);
        onBlur?.(event);
      }}
    />
  );
}
