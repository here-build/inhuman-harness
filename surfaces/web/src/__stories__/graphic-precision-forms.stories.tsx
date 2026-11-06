import { useId, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { parseColor } from "react-aria-components";

import { Page, Schemes, Section } from "./brand-kit.js";
import { Checkbox } from "../components/ui/checkbox.js";
import {
  CheckboxGroup,
  ColorArea,
  ColorField,
  ColorSlider,
  ColorSliderTrack,
  ColorSwatch,
  ColorSwatchPicker,
  ColorSwatchPickerItem,
  ColorThumb,
  ColorWheel,
  ColorWheelTrack,
  Description,
  FieldButton,
  FieldError,
  FieldInput,
  Form,
  Group,
  Label,
  Meter,
  NumberField,
  ProgressBar,
  SearchField,
  Slider,
  SliderOutput,
  SliderThumb,
  SliderTrack,
  ToggleButton,
  ToggleButtonGroup,
} from "../components/ui/form-controls.js";

const meta = {
  title: "Graphic Precision/Forms",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Editing: Story = {
  render: () => (
    <Page
      historical={false}
      title="Form controls"
      lede="Compose persistent labels, descriptions, and recovery messages around real inputs."
    >
      <Section
        title="Search and quantities"
        note="Tab through the fields. Escape clears search; Arrow Up and Arrow Down adjust quantities."
      >
        <Schemes className="rounded-none">
          <EditingExamples />
        </Schemes>
      </Section>
    </Page>
  ),
};

function EditingExamples() {
  const [query, setQuery] = useState("Release notes");
  const [copies, setCopies] = useState(3);
  const [saved, setSaved] = useState(false);
  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault();
        setSaved(true);
      }}
    >
      <SearchField name="query" value={query} onChange={setQuery}>
        <Label>Search documents</Label>
        <Group>
          <FieldInput placeholder="Title or author" />
          <FieldButton>Clear</FieldButton>
        </Group>
        <Description>Search by title or author. Your current text is preserved while editing.</Description>
      </SearchField>
      <NumberField name="copies" value={copies} onChange={setCopies} minValue={1} maxValue={12}>
        <Label>Copies</Label>
        <Group>
          <FieldButton slot="decrement">Decrease</FieldButton>
          <FieldInput />
          <FieldButton slot="increment">Increase</FieldButton>
        </Group>
        <Description>Choose between 1 and 12 copies.</Description>
        <FieldError />
      </NumberField>
      <NumberField defaultValue={0} minValue={1} isInvalid validationBehavior="aria">
        <Label>Reviewers</Label>
        <Group>
          <FieldInput />
          <FieldButton slot="increment">Increase</FieldButton>
        </Group>
        <FieldError>Choose at least one reviewer before sharing.</FieldError>
      </NumberField>
      <SearchField isDisabled defaultValue="Archived documents">
        <Label>Archive search</Label>
        <Group>
          <FieldInput />
          <FieldButton>Clear</FieldButton>
        </Group>
        <Description>Archive search is unavailable until the archive is connected.</Description>
      </SearchField>
      <FieldButton type="submit">Save preferences</FieldButton>
      <p role="status" className="text-sm text-muted">
        {saved ? `Saved ${copies} copies. Search: ${query || "all documents"}.` : "Preferences have not been saved."}
      </p>
    </Form>
  );
}

export const Measurements: Story = {
  render: () => (
    <Page
      historical={false}
      title="Values and progress"
      lede="Ordinary numbers remain in the content face, with tabular figures where they aid comparison."
    >
      <Section
        title="Keyboard-adjustable values"
        note="Use arrow keys, Home, and End. The progress indicators follow the completion slider without decorative motion."
      >
        <Schemes className="rounded-none">
          <MeasurementExamples />
        </Schemes>
      </Section>
    </Page>
  ),
};

function MeasurementExamples() {
  const [completion, setCompletion] = useState(40);
  return (
    <div className="flex flex-col gap-6">
      <Slider value={completion} onChange={(value) => setCompletion(value as number)} step={5}>
        <div className="flex justify-between">
          <Label>Completion</Label>
          <SliderOutput />
        </div>
        <SliderTrack>
          <SliderThumb />
        </SliderTrack>
      </Slider>
      <Slider defaultValue={[20, 80]}>
        <Label>Review window</Label>
        <SliderOutput />
        <SliderTrack>
          <SliderThumb index={0} aria-label="Start" />
          <SliderThumb index={1} aria-label="End" />
        </SliderTrack>
      </Slider>
      <Slider isDisabled defaultValue={25}>
        <Label>Archived completion</Label>
        <SliderOutput />
        <SliderTrack>
          <SliderThumb />
        </SliderTrack>
      </Slider>
      <Meter value={completion}>
        {({ valueText }) => (
          <div className="flex justify-between">
            <Label>Storage used</Label>
            <span className="tabular-nums">{valueText}</span>
          </div>
        )}
      </Meter>
      <ProgressBar value={completion}>
        {({ valueText }) => (
          <div className="flex justify-between">
            <Label>Export progress</Label>
            <span className="tabular-nums">{valueText}</span>
          </div>
        )}
      </ProgressBar>
      <ProgressBar isIndeterminate>
        <Label>Preparing files…</Label>
      </ProgressBar>
    </div>
  );
}

export const Choices: Story = {
  render: () => (
    <Page
      historical={false}
      title="Choices and modes"
      lede="Field labels remain natural case. Commands and modes use petite caps, with explicit selection markers."
    >
      <Section title="Selection" note="Space selects a checkbox or toggle. Arrow keys move within a toggle group.">
        <Schemes className="rounded-none">
          <ChoiceExamples />
        </Schemes>
      </Section>
    </Page>
  ),
};

function ChoiceExamples() {
  const viewLabel = useId();
  const [channels, setChannels] = useState(["email"]);
  const [pinned, setPinned] = useState(false);
  return (
    <div className="flex flex-col gap-6">
      <CheckboxGroup
        value={channels}
        onChange={setChannels}
        isInvalid={channels.length === 0}
        validationBehavior="aria"
      >
        <Label>Delivery channels</Label>
        <Checkbox value="email">Email</Checkbox>
        <Checkbox value="inbox">Inbox</Checkbox>
        <Checkbox value="sms" isDisabled>
          Text message (not connected)
        </Checkbox>
        <Description>Choose at least one channel for review requests.</Description>
        <FieldError>Select Email or Inbox to receive review requests.</FieldError>
      </CheckboxGroup>
      <CheckboxGroup isDisabled defaultValue={["history"]}>
        <Label>Retention settings</Label>
        <Checkbox value="history">Keep revision history</Checkbox>
      </CheckboxGroup>
      <Group aria-label="Document commands">
        <ToggleButton isSelected={pinned} onChange={setPinned}>
          Pin document
        </ToggleButton>
        <ToggleButton isDisabled>Lock document</ToggleButton>
      </Group>
      <div className="flex flex-col gap-2">
        <Label id={viewLabel}>Document view</Label>
        <ToggleButtonGroup
          aria-labelledby={viewLabel}
          selectionMode="single"
          defaultSelectedKeys={["list"]}
          disallowEmptySelection
        >
          <ToggleButton id="list">List</ToggleButton>
          <ToggleButton id="grid">Grid</ToggleButton>
          <ToggleButton id="timeline" isDisabled>
            Timeline
          </ToggleButton>
        </ToggleButtonGroup>
      </div>
      <p role="status" className="text-sm text-muted">
        {pinned ? "Document pinned." : "Document is not pinned."}
      </p>
    </div>
  );
}

export const Colors: Story = {
  render: () => (
    <Page
      historical={false}
      title="Color editing"
      lede="The edited color appears only in the preview and editing surfaces; surrounding controls and keyboard focus stay neutral."
    >
      <Section
        title="One shared color"
        note="Edit the color value, use the arrow keys on the area and wheel, or choose a swatch. Every control updates the same value."
      >
        <Schemes className="rounded-none">
          <ColorExamples />
        </Schemes>
      </Section>
    </Page>
  ),
};

function ColorExamples() {
  const paletteLabel = useId();
  const [color, setColor] = useState(parseColor("hsl(210, 70%, 50%)"));
  return (
    <div className="flex flex-col gap-5">
      <ColorField
        value={color}
        onChange={(value) => {
          if (value) setColor(value);
        }}
      >
        <Label>Category color</Label>
        <FieldInput />
        <Description>Enter a hexadecimal color, such as #267fd9.</Description>
        <FieldError />
      </ColorField>
      <div className="flex items-center gap-3">
        <ColorSwatch color={color} />
        <span className="text-sm">Current color: {color.toString("hex")}</span>
      </div>
      <ColorArea
        aria-label="Category color"
        colorSpace="hsl"
        xChannel="saturation"
        yChannel="lightness"
        value={color}
        onChange={setColor}
      >
        <ColorThumb />
      </ColorArea>
      <ColorSlider channel="hue" colorSpace="hsl" value={color} onChange={setColor}>
        <Label>Hue</Label>
        <SliderOutput />
        <ColorSliderTrack>
          <ColorThumb />
        </ColorSliderTrack>
      </ColorSlider>
      <ColorSlider channel="alpha" value={color} onChange={setColor}>
        <Label>Opacity</Label>
        <SliderOutput />
        <ColorSliderTrack>
          <ColorThumb />
        </ColorSliderTrack>
      </ColorSlider>
      <ColorWheel aria-label="Category hue" outerRadius={96} innerRadius={72} value={color} onChange={setColor}>
        <ColorWheelTrack />
        <ColorThumb />
      </ColorWheel>
      <div className="flex flex-col gap-2">
        <Label id={paletteLabel}>Suggested colors</Label>
        <ColorSwatchPicker aria-labelledby={paletteLabel} value={color} onChange={setColor}>
          <ColorSwatchPickerItem color="#267fd9" />
          <ColorSwatchPickerItem color="#9058c8" />
          <ColorSwatchPickerItem color="#288263" />
          <ColorSwatchPickerItem color="#cf6545" isDisabled />
        </ColorSwatchPicker>
      </div>
      <ColorField defaultValue="#267fd9" isDisabled>
        <Label>Inherited color</Label>
        <FieldInput />
        <Description>This color is managed by the workspace.</Description>
      </ColorField>
      <ColorField defaultValue="#267fd9" isInvalid validationBehavior="aria">
        <Label>Conflicting category color</Label>
        <FieldInput />
        <FieldError>Choose a different color to distinguish this category.</FieldError>
      </ColorField>
    </div>
  );
}
