export function isMogrtText(value: any): boolean {
  return (
    Boolean(value) &&
    typeof value.getText === "function" &&
    typeof value.setText === "function"
  );
}

// Premiere 27.0 returns MOGRT text as a typed object that createKeyframe
// accepts. Editing the current object keeps its font and size.
export function editedMogrtText(current: any, text: string): any {
  if (!current.setText(text)) {
    throw new Error("Premiere rejected the MOGRT text");
  }
  return current;
}
