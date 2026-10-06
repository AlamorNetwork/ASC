import { Example } from "@floot/examples";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./Select";

export default function SelectShowcase() {
  return (
    <>
      <h1>Select</h1>
      <p>
        A trigger that opens a list of options and shows the chosen one. Open a
        trigger to see its options.
      </p>

      <h2>Examples</h2>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "1rem",
          alignItems: "flex-start",
        }}
      >
        <Example title="Basic" width={260}>
          <Select>
            <SelectTrigger>
              <SelectValue placeholder="Select a fruit" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="apple">Apple</SelectItem>
                <SelectItem value="banana">Banana</SelectItem>
                <SelectItem value="orange">Orange</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Example>

        <Example title="Items with markers" width={260}>
          <Select>
            <SelectTrigger>
              <SelectValue placeholder="Select a fruit" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="apple">
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--spacing-2)",
                    }}
                  >
                    <div
                      style={{
                        background: "red",
                        height: "var(--spacing-2)",
                        width: "var(--spacing-2)",
                        borderRadius: "var(--spacing-2)",
                      }}
                    />
                    Apple
                  </div>
                </SelectItem>
                <SelectItem value="banana">
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--spacing-2)",
                    }}
                  >
                    <div
                      style={{
                        background: "yellow",
                        height: "var(--spacing-2)",
                        width: "var(--spacing-2)",
                        borderRadius: "var(--spacing-2)",
                      }}
                    />
                    Banana
                  </div>
                </SelectItem>
                <SelectItem value="orange">
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--spacing-2)",
                    }}
                  >
                    <div
                      style={{
                        background: "orange",
                        height: "var(--spacing-2)",
                        width: "var(--spacing-2)",
                        borderRadius: "var(--spacing-2)",
                      }}
                    />
                    Orange
                  </div>
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Example>

        <Example title="Groups and labels" width={260}>
          <Select>
            <SelectTrigger>
              <SelectValue placeholder="Select a food" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Fruits</SelectLabel>
                <SelectItem value="apple">Apple</SelectItem>
                <SelectItem value="banana">Banana</SelectItem>
              </SelectGroup>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Vegetables</SelectLabel>
                <SelectItem value="carrot">Carrot</SelectItem>
                <SelectItem value="potato">Potato</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Example>

        <Example title="Disabled" width={260}>
          <Select disabled>
            <SelectTrigger>
              <SelectValue placeholder="Disabled select" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="1">Option 1</SelectItem>
                <SelectItem value="2">Option 2</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Example>

        <Example title="Long options" width={260}>
          <Select>
            <SelectTrigger>
              <SelectValue placeholder="Select a long option" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="1">
                  This is a very long option that should be truncated
                </SelectItem>
                <SelectItem value="2">
                  Another long option that demonstrates width handling
                </SelectItem>
                <SelectItem value="3">Short option</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Example>
      </div>
    </>
  );
}
