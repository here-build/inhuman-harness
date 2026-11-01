import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Page, Schemes, Section } from "./brand-kit.js";
import {
  AutocompleteRoot,
  useFilter,
  SearchField,
  Label,
  FieldInput,
  Menu,
  MenuItem,
  ColorPicker,
  ColorField,
  ColorSwatch,
  Slider,
  SliderTrack,
  SliderFill,
  SliderThumb,
  SliderOutput,
  NativeSelect,
} from "../components/ui/index.js";

const meta = { title: "Graphic Precision/Composition", parameters: { layout: "fullscreen" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const SharedContexts: Story = {
  render: () => (
    <Page
      historical={false}
      title="Composition"
      lede="Semantic providers synchronize their styled children without introducing a second event or positioning owner."
    >
      <Section
        title="Filtered commands and synchronized values"
        note="The command filter keeps focus in its input. Color controls share one value. Native selects preserve browser-owned menus."
      >
        <Schemes>
          <Examples />
        </Schemes>
      </Section>
    </Page>
  ),
};
function Examples() {
  const [action, setAction] = useState("No command selected");
  const { contains } = useFilter({ sensitivity: "base" });
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <AutocompleteRoot filter={contains}>
          <SearchField>
            <Label>Find a command</Label>
            <FieldInput placeholder="Search commands" />
          </SearchField>
          <Menu aria-label="Project commands" onAction={(key) => setAction(String(key))}>
            <MenuItem id="Export CSV">Export CSV</MenuItem>
            <MenuItem id="Create project">Create project</MenuItem>
            <MenuItem id="Open settings">Open settings</MenuItem>
          </Menu>
        </AutocompleteRoot>
        <p role="status" className="text-sm">
          {action}
        </p>
      </div>
      <ColorPicker defaultValue="#758a42">
        <div className="flex items-end gap-3">
          <ColorField>
            <Label>Data category color</Label>
            <FieldInput />
          </ColorField>
          <ColorSwatch aria-label="Current category color" />
        </div>
      </ColorPicker>
      <Slider defaultValue={40} minValue={0} maxValue={100}>
        <div className="flex items-center justify-between">
          <Label>Preview width</Label>
          <SliderOutput />
        </div>
        <SliderTrack>
          <SliderFill />
          <SliderThumb />
        </SliderTrack>
      </Slider>
      <label className="flex flex-col gap-1 text-sm">
        Default workspace
        <NativeSelect defaultValue="local">
          <option value="local">This device</option>
          <option value="team">Team workspace</option>
        </NativeSelect>
      </label>
    </div>
  );
}
