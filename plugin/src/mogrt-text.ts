export function isMogrtText(value: any): boolean {
  return (
    Boolean(value) &&
    typeof value.getText === "function" &&
    typeof value.setText === "function"
  );
}

// Premiere 27.1 Beta accepts a MogrtText write and then renders the text empty.
// Every public write path behaves the same, so refuse instead of erasing text.
export function assertMogrtTextUnchanged(current: any): void {
  if (isMogrtText(current)) {
    throw new Error(
      "Writing MOGRT text is disabled because Premiere 27.1 Beta erases the text",
    );
  }
}
