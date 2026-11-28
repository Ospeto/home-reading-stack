--[[--
One-screen, square-cornered page renderer.

`lighthouse_views.lua` decides what a screen says; this module decides what it
looks like. It draws a page model as a single KOReader widget:

  * a header (back, title, overflow) with a hairline under it,
  * headline cells (the stats strip) or a three-segment switch (the library),
  * a two-column band with a hairline between its columns,
  * rows that carry a cover on the left, a bold title, a secondary line, a pixel
    progress bar and a right-hand value column,
  * a compact pixel heatmap (52 weeks of seven days, one rect per day),
  * a footer with a hairline above it.

Nothing here scrolls or pages by itself: the caller lays the page out with
`Ui.pagePlan` / `Ui.listPlan`, and the plan and the model decide how much fits.
That is the whole reason the reading-statistics screen is one page instead of
ten: the picture was a row per week before, and it is a rect per day now.

Every corner is 90 degrees: this module owns no radius, the switch's active
segment is a filled rect rather than a rounded chip, and the widget constructions
it performs for the plugin's own dialogs go through `Ui.square`.

Interaction, on both device families:

  * touch: a tap hit-tests the recorded row rectangles, top-most first;
  * keys: Next/Prev move a focus line down the focusable rows, Select activates,
    Back goes up one level - so a Kindle with a 5-way controller is as usable as
    a Paperwhite.

The header already carries the house affordances - back, title, overflow - so a
nested view needs no widget of its own; what Back *does* is the caller's, and it
arrives through `on_back` (see `PageWidget:onBack`).
]]

local Blitbuffer = require("ffi/blitbuffer")
local Device = require("device")
local Font = require("ui/font")
local Geom = require("ui/geometry")
local GestureRange = require("ui/gesturerange")
local InputContainer = require("ui/widget/container/inputcontainer")
local Widget = require("ui/widget/widget")
local FrameContainer = require("ui/widget/container/framecontainer")
local HorizontalGroup = require("ui/widget/horizontalgroup")
local HorizontalSpan = require("ui/widget/horizontalspan")
local LeftContainer = require("ui/widget/container/leftcontainer")
local RightContainer = require("ui/widget/container/rightcontainer")
local CenterContainer = require("ui/widget/container/centercontainer")
local LineWidget = require("ui/widget/linewidget")
local TextWidget = require("ui/widget/textwidget")
local VerticalGroup = require("ui/widget/verticalgroup")
local VerticalSpan = require("ui/widget/verticalspan")
local UIManager = require("ui/uimanager")

local Ui = require("lighthouse_ui")
local Page = {}

--- A footer field as a string. The model is the only writer, but a footer is
-- not worth a raise: an absent field reads as absent, never as `nil` or as
-- `function: 0x…` on the glass.
-- @param value any
-- @treturn string
local function footerText(value)
    local kind = type(value)
    if kind == "string" then return value end
    if kind == "number" then return tostring(value) end
    return ""
end

-- E-ink palette. Every one of these has a hard fallback, because a build that
-- lacks the shade must get a readable page rather than a raise in the paint
-- pass, where nothing can catch it.
local COLOR_BLACK = Blitbuffer.COLOR_BLACK
local COLOR_WHITE = Blitbuffer.COLOR_WHITE
local COLOR_MUTED = Blitbuffer.COLOR_DARK_GRAY or COLOR_BLACK
local COLOR_DIVIDER = Blitbuffer.COLOR_LIGHT_GRAY or Blitbuffer.COLOR_GRAY or COLOR_BLACK
local COLOR_BORDER = Blitbuffer.COLOR_GRAY or Blitbuffer.COLOR_DARK_GRAY or COLOR_BLACK
local COLOR_PLACEHOLDER_BG = Blitbuffer.COLOR_GRAY_E or COLOR_WHITE
local COLOR_TRACK = Blitbuffer.COLOR_LIGHT_GRAY or Blitbuffer.COLOR_GRAY or COLOR_WHITE
local HEAT_COLORS = {
    [0] = Blitbuffer.COLOR_GRAY_E or COLOR_TRACK,
    [1] = Blitbuffer.COLOR_LIGHT_GRAY or COLOR_TRACK,
    [2] = Blitbuffer.COLOR_GRAY or Blitbuffer.COLOR_DARK_GRAY or COLOR_BLACK,
    [3] = Blitbuffer.COLOR_DARK_GRAY or COLOR_BLACK,
    [4] = COLOR_BLACK,
}

--- A filled rectangle: the plugin's only drawing primitive.
-- Bars, hairlines, column rules, the switch's active segment and every heatmap
-- cell are one of these. A rect has no corner to round.
local Rect = Widget:extend{
    width = 1,
    height = 1,
    color = COLOR_BLACK,
}

function Rect:getSize()
    return Geom:new{ w = self.width, h = self.height }
end

function Rect:paintTo(bb, x, y)
    if self.width < 1 or self.height < 1 then return end
    bb:paintRect(x, y, self.width, self.height, self.color)
end

--- The 52-week activity picture: one rect per day, weeks as columns.
local Heatmap = Widget:extend{
    columns = nil,
    cell_w = 1,
    cell_h = 1,
    gap = 0,
}

function Heatmap:getSize()
    local count = self.columns and #self.columns or 0
    local width = count > 0 and (count * self.cell_w + (count - 1) * self.gap) or 0
    return Geom:new{ w = width, h = 7 * self.cell_h + 6 * self.gap }
end

function Heatmap:paintTo(bb, x, y)
    if not self.columns then return end
    for column_index = 1, #self.columns do
        local column = self.columns[column_index]
        for day_index = 1, 7 do
            local level = column[day_index]
            -- A day the payload did not carry stays blank: an empty cell must
            -- not read as "no reading that day".
            if level ~= nil then
                local color = HEAT_COLORS[math.floor(level + 0.5)] or COLOR_BLACK
                bb:paintRect(
                    x + (column_index - 1) * (self.cell_w + self.gap),
                    y + (day_index - 1) * (self.cell_h + self.gap),
                    self.cell_w,
                    self.cell_h,
                    color
                )
            end
        end
    end
end

--- A tappable row; content rows are also the ones the key cycle can land on.
-- The page hit-tests these rectangles on touch, and the key cycle moves a focus
-- line between the content rows only.
local Panel = Widget:extend{
    child = nil,
    action = nil,
    hold_action = nil,
    focus_line = nil,
    dimen = nil,
}

function Panel:getSize()
    if not self.child then return Geom:new{ w = 0, h = 0 } end
    return self.child:getSize()
end

function Panel:paintTo(bb, x, y)
    if not self.child then return end
    self.child:paintTo(bb, x, y)
    local size = self.child:getSize()
    self.dimen = Geom:new{ x = x, y = y, w = size.w, h = size.h }
end

--- Shows or hides this row's focus line (keyed devices only).
-- A single thin line under the row is enough on e-ink and, unlike inverting the
-- whole row, costs a partial refresh instead of a flash.
-- @boolean focused
function Panel:setFocused(focused)
    if not self.focus_line then return end
    self.focus_line.background = focused and COLOR_BLACK or COLOR_DIVIDER
    UIManager:setDirty(self, "ui")
end

-- ----------------------------------------------------------------------------
-- Text helpers
-- ----------------------------------------------------------------------------

local face_cache = {}

--- One font face, cached per name and pixel size.
--
-- `size` is the size this module wants in PIXELS, because every measure it
-- derives a face from - `plan.header`, `plan.row_h`, `plan.footer` - is a pixel
-- measure. `Font:getFace` does not take pixels: KOReader multiplies the size it
-- is handed by the device scale (`scaleBySize`), so a pixel count passed
-- straight in comes out two to three times too large. That is what pushed the
-- row type past the row band it sits in, and why the type looked nothing like
-- the row height it was derived from. Convert back to the units the runtime
-- expects, and the size asked for is the size drawn.
-- @string name KOReader font-map key
-- @number size pixel size
-- @number[opt] scale pixels per unit for this device (default: 1 unit = 1 pixel)
-- @treturn table|nil face
local function face(name, size, scale)
    local pixels = math.floor(tonumber(size) or 0)
    if pixels < 8 then pixels = 8 end
    local key = name .. ":" .. tostring(pixels)
    local cached = face_cache[key]
    if cached ~= nil then return cached or nil end
    local units = Ui.faceUnits(pixels, scale)
    local ok, built = pcall(Font.getFace, Font, name, units)
    face_cache[key] = (ok and built) or false
    if not ok then return nil end
    return built
end

--- A single-line text widget, truncated with an ellipsis inside `width`.
-- @string text
-- @tparam table|nil text_face
-- @tparam table options { bold, width, color, align }
-- @treturn table TextWidget
local function label(text, text_face, options)
    options = options or {}
    return TextWidget:new{
        text = tostring(text or ""),
        face = text_face,
        bold = options.bold == true,
        fgcolor = options.color or COLOR_BLACK,
        max_width = options.width,
        truncate_with_ellipsis = true,
        padding = 0,
        alignment = options.align,
    }
end

--- A horizontal rule the width of the page.
-- @number width
-- @number thickness
-- @param[opt] color
-- @treturn table LineWidget
local function rule(width, thickness, color)
    return LineWidget:new{
        dimen = Geom:new{ w = math.max(width, 1), h = math.max(thickness, 1) },
        background = color or COLOR_BLACK,
    }
end

--- A vertical rule between two columns.
-- @number height
-- @number thickness
-- @param[opt] color
-- @treturn table Rect
local function column_rule(height, thickness, color)
    return Rect:new{ width = math.max(thickness, 1), height = math.max(height, 1), color = color or COLOR_BLACK }
end

--- A progress bar: filled part, then the track.
-- @number filled pixels already computed by `Ui.barFill`
-- @number total bar width
-- @number height
-- @treturn table widget
local function progressBar(filled, total, height)
    local bar_height = math.max(math.floor(height), 2)
    local track_width = math.max(math.floor(total) - filled, 0)
    return HorizontalGroup:new{
        align = "center",
        Rect:new{ width = math.max(filled, 0), height = bar_height, color = COLOR_BLACK },
        Rect:new{ width = track_width, height = bar_height, color = COLOR_TRACK },
    }
end

-- ----------------------------------------------------------------------------
-- The page widget
-- ----------------------------------------------------------------------------

local PageWidget = InputContainer:extend{
    model = nil,
    plan = nil,
    faces = nil,
    on_action = nil,
    on_hold = nil,
    on_overflow = nil,
    on_switch = nil,
    cover_widget = nil,
    --: Whether rows reserve a cover column (the reader's preference).
    covers = true,
    dimen = nil,
}

--- Font faces for one page, sized from the plan so the type scale follows the
--- screen instead of a table of magic numbers.
--
-- Both plans (`Ui.pagePlan` for the statistics page, `Ui.listPlan` for the
-- library) feed this, and they carry different bands, so every measure falls
-- back to a section-sized value rather than assuming the other screen's plan.
--
-- The row title is the one face that is NOT derived from a leftover band: it
-- comes from `Ui.rowTitlePx`, which the plan itself fills in. A band-derived
-- height is a layout outcome, so a type size taken straight from it answers a
-- different question than "how big must this be to read", and the old fixed
-- 120 px ceiling made a 178 px band on a 300 dpi panel draw exactly the 22 px
-- glyphs a 167 dpi one does - 7.4 pt of title where the reader needed 10.
-- @tparam table plan result of a `Ui` layout function
-- @treturn table faces
local function buildFaces(plan)
    local scale = plan.scale or 1
    local header = math.max(math.floor((plan.header or 40) * 0.5), 9)
    local section_head = plan.section_head or plan.subline_h or header
    local heading = math.max(math.floor(section_head * 0.52), 9)
    local band_head = math.max(math.floor((plan.band_head or section_head) * 0.66), 9)
    local hero_label = math.max(math.floor((plan.hero_label or section_head) * 0.82), 9)
    local hero_value = math.max(math.floor((plan.hero_value or header) * 0.86), 9)
    local band = plan.reading_h or plan.row_h or 88
    local row_title
    if type(plan.row_title_px) == "number" and plan.row_title_px > 0 then
        row_title = math.floor(plan.row_title_px)
    else
        row_title = Ui.rowTitlePx(band, scale)
    end
    local row_small = math.max(row_title - math.floor(scale * 3), 11)
    local footer = math.max(math.floor((plan.footer or 26) * 0.6), 9)
    --: Paragraph type. The plan carries the deliberate size (`Ui.bodyType`), so
    --: this face is the size the line box was derived FROM and not a fraction of
    --: whatever box was left over: 82 % fill instead of a 41 px box drawing 16 px
    --: glyphs (39 %) on a Paperwhite 5.
    return {
        header = face("cfont", header, scale),
        title = face("cfont", math.floor(plan.header * 0.52), scale),
        heading = face("cfont", heading, scale),
        band_head = face("cfont", band_head, scale),
        hero_label = face("cfont", hero_label, scale),
        hero_value = face("cfont", hero_value, scale),
        row_title = face("cfont", math.max(row_title, 12), scale),
        row_small = face("cfont", math.max(row_small, 10), scale),
        row_value = face("cfont", math.max(row_title, 12), scale),
        footer = face("cfont", math.max(footer, 10), scale),
        body = face("cfont", math.max(math.floor(tonumber(plan.body_px) or 0), row_small, 10), scale),
    }
end

--- Builds the header row: back, title, optional search, overflow.
-- @tparam table self page
-- @treturn table widget
function PageWidget:buildHeader()
    local plan = self.plan
    local width = plan.content_w
    local actions = self.model.header_actions
    local has_search = type(actions) == "table" and actions.search == true
    local extra = type(actions) == "table" and type(actions.extra) == "table"
        and type(actions.extra.action) == "table" and actions.extra or nil

    local back_w = math.floor(width * 0.14)
    local overflow_w = (has_search or extra) and math.floor(width * 0.10) or math.floor(width * 0.14)
    local search_w = has_search and math.floor(width * 0.20) or 0
    local extra_w = extra and math.floor(width * 0.24) or 0
    local title_w = math.max(width - back_w - search_w - extra_w - overflow_w, 1)

    local back = LeftContainer:new{
        dimen = Geom:new{ w = back_w, h = plan.header },
        label(Ui.GLYPH.back, self.faces.header, { width = back_w }),
    }
    local title = CenterContainer:new{
        dimen = Geom:new{ w = title_w, h = plan.header },
        label(self.model.title or "", self.faces.title, { bold = true, width = title_w, align = "center" }),
    }
    local overflow = RightContainer:new{
        dimen = Geom:new{ w = overflow_w, h = plan.header },
        label(Ui.GLYPH.overflow, self.faces.header, { width = overflow_w, align = "right" }),
    }

    local back_panel = Panel:new{
        child = back,
        action = { kind = "back" },
    }
    local overflow_panel = Panel:new{
        child = overflow,
        action = { kind = "overflow" },
    }
    self:register(back_panel)

    local group = HorizontalGroup:new{
        align = "center",
        back_panel,
        title,
    }
    if extra then
        local extra_box = RightContainer:new{
            dimen = Geom:new{ w = extra_w, h = plan.header },
            label(extra.label or "", self.faces.row_small, { bold = true, width = extra_w, align = "right" }),
        }
        local extra_panel = Panel:new{
            child = extra_box,
            action = extra.action,
        }
        self:register(extra_panel)
        group[#group + 1] = extra_panel
    end
    if has_search then
        local search_text = actions.search_label or "Search"
        local search = RightContainer:new{
            dimen = Geom:new{ w = search_w, h = plan.header },
            label(search_text, self.faces.heading, { bold = true, width = search_w, align = "right" }),
        }
        local search_panel = Panel:new{
            child = search,
            action = { kind = "search" },
        }
        self:register(search_panel)
        group[#group + 1] = search_panel
    end
    self:register(overflow_panel)
    group[#group + 1] = overflow_panel
    return group
end

--- Builds the library's three-segment switch.
-- The active segment is a filled rect with inverted text - the e-ink equivalent
-- of the accepted design's black tab - and the other two are plain cells divided
-- by hairlines.
-- @tparam table self page
-- @treturn table widget
function PageWidget:buildSwitch()
    local plan = self.plan
    local width = plan.content_w
    local segments = self.model.switch or {}
    if #segments == 0 then return VerticalSpan:new{ width = 0 } end
    local thickness = plan.hairline
    local count = #segments
    local cell_w = math.floor((width - (count - 1) * thickness) / count)
    local group = HorizontalGroup:new{ align = "center" }
    for segment_index = 1, count do
        local segment = segments[segment_index]
        local cell
        if segment.active then
            cell = FrameContainer:new{
                radius = Ui.tokens.corner_radius,
                bordersize = thickness,
                padding = 0,
                background = COLOR_BLACK,
                CenterContainer:new{
                    dimen = Geom:new{ w = cell_w - 2 * thickness, h = plan.switch_h - 2 * thickness },
                    label(segment.label, self.faces.heading, {
                        bold = true,
                        color = COLOR_WHITE,
                        width = cell_w - 2 * thickness,
                        align = "center",
                    }),
                },
            }
        else
            cell = CenterContainer:new{
                dimen = Geom:new{ w = cell_w, h = plan.switch_h },
                label(segment.label, self.faces.heading, {
                    color = COLOR_MUTED,
                    width = cell_w,
                    align = "center",
                }),
            }
        end
        local panel = Panel:new{
            child = cell,
            action = { kind = "switch", key = segment.key },
        }
        self:register(panel)
        group[#group + 1] = panel
        if segment_index < count then
            group[#group + 1] = column_rule(plan.switch_h, thickness, COLOR_BORDER)
        end
    end
    return VerticalGroup:new{
        align = "center",
        rule(width, thickness, COLOR_BORDER),
        group,
        rule(width, thickness, COLOR_BORDER),
    }
end

--- The strip of headline cells.
-- @tparam table self page
-- @tparam table cells array of { label, value }
-- @treturn table widget
function PageWidget:buildHero(cells)
    local plan = self.plan
    local width = plan.content_w
    local count = math.max(#cells, 1)
    local thickness = plan.hairline
    local cell_w = math.floor((width - (count - 1) * thickness) / count)
    local cell_pad = math.max(math.floor(plan.gap), 4)
    local label_gap = math.max(math.floor(plan.gap / 3), 2)
    local group = HorizontalGroup:new{ align = "top" }
    for cell_index = 1, count do
        local cell = cells[cell_index] or { label = "", value = "" }
        local pad_left = cell_index > 1 and cell_pad or 0
        local pad_right = cell_index < count and cell_pad or 0
        local inner_w = math.max(cell_w - pad_left - pad_right, 1)
        local content = VerticalGroup:new{
            align = "left",
            label(cell.label, self.faces.hero_label, { width = inner_w, color = COLOR_MUTED }),
            VerticalSpan:new{ width = label_gap },
            label(cell.value, self.faces.hero_value, { bold = true, width = inner_w }),
        }
        local padded = pad_left > 0
            and HorizontalGroup:new{
                align = "top",
                HorizontalSpan:new{ width = pad_left },
                content,
            }
            or content
        group[#group + 1] = LeftContainer:new{
            dimen = Geom:new{ w = cell_w, h = plan.hero },
            padded,
        }
        if cell_index < count then group[#group + 1] = column_rule(plan.hero, thickness, COLOR_DIVIDER) end
    end
    return group
end

--- The two-column band (library counts on the left, year figures on the right).
-- @tparam table self page
-- @tparam table columns array of { heading, rows = { { label, value } } }
-- @treturn table widget
function PageWidget:buildBand(columns)
    local plan = self.plan
    local width = plan.content_w
    local thickness = plan.hairline
    local count = math.max(#columns, 1)
    local column_w = math.floor((width - (count - 1) * thickness) / count)
    local cell_pad = math.max(math.floor(plan.gap), 4)

    local first = columns[1] or { rows = {} }
    local second = columns[2]
    local band = VerticalGroup:new{ align = "left" }
    local head_row = HorizontalGroup:new{ align = "top" }
    for column_index = 1, count do
        local column = columns[column_index] or { rows = {} }
        local pad_left = column_index > 1 and cell_pad or 0
        local pad_right = column_index < count and cell_pad or 0
        local inner_w = math.max(column_w - pad_left - pad_right, 1)
        local heading_label = label(column.heading or "", self.faces.band_head, { bold = true, width = inner_w })
        local heading_cell = pad_left > 0
            and HorizontalGroup:new{ align = "center", HorizontalSpan:new{ width = pad_left }, heading_label }
            or heading_label
        head_row[#head_row + 1] = LeftContainer:new{
            dimen = Geom:new{ w = column_w, h = plan.band_head },
            heading_cell,
        }
        if column_index < count then head_row[#head_row + 1] = column_rule(plan.band_head, thickness, COLOR_DIVIDER) end
    end
    band[#band + 1] = head_row

    local row_count = math.max(#first.rows, second and #second.rows or 0)
    for row_index = 1, row_count do
        local group = HorizontalGroup:new{ align = "top" }
        for column_index = 1, count do
            local column = columns[column_index] or { rows = {} }
            local entry = column.rows[row_index]
            local pad_left = column_index > 1 and cell_pad or 0
            local pad_right = column_index < count and cell_pad or 0
            local inner_w = math.max(column_w - pad_left - pad_right, 1)
            local label_w = math.max(math.floor((inner_w - plan.gap) * 0.62), 1)
            local val_w = math.max(inner_w - label_w, 1)
            local cell = HorizontalGroup:new{ align = "center" }
            if pad_left > 0 then cell[#cell + 1] = HorizontalSpan:new{ width = pad_left } end
            if entry then
                cell[#cell + 1] = LeftContainer:new{
                    dimen = Geom:new{ w = label_w, h = plan.band_row },
                    label(entry.label or "", self.faces.row_small, {
                        width = label_w,
                        color = COLOR_MUTED,
                    }),
                }
                cell[#cell + 1] = RightContainer:new{
                    dimen = Geom:new{ w = val_w, h = plan.band_row },
                    label(entry.value or "", self.faces.row_value, {
                        bold = true,
                        width = val_w,
                        align = "right",
                    }),
                }
            end
            group[#group + 1] = LeftContainer:new{
                dimen = Geom:new{ w = column_w, h = plan.band_row },
                cell,
            }
            if column_index < count then group[#group + 1] = column_rule(plan.band_row, thickness, COLOR_DIVIDER) end
        end
        band[#band + 1] = group
    end
    return band
end

--- A section heading line: label on the left, a count or window on the right.
-- @tparam table self page
-- @tparam table heading { left, right }
-- @treturn table widget
function PageWidget:buildSectionHeading(heading)
    local plan = self.plan
    local width = plan.content_w
    local right_w = math.floor(width * 0.42)
    local left_w = width - right_w
    local left_text = heading.left and heading.left ~= "" and Ui.sectionText(heading.left) or ""
    local left_widget = label(left_text, self.faces.heading, { bold = true, width = left_w })
    local right_widget = label(heading.right or "", self.faces.heading, {
        width = right_w,
        color = COLOR_MUTED,
        align = "right",
    })
    return HorizontalGroup:new{
        align = "center",
        LeftContainer:new{ dimen = Geom:new{ w = left_w, h = plan.section_head }, left_widget },
        RightContainer:new{ dimen = Geom:new{ w = right_w, h = plan.section_head }, right_widget },
    }
end

--- Shared 1px bordered cover frame or neutral e-ink placeholder.
-- @tparam table page PageWidget instance
-- @param cover_id number|nil
-- @number cover_w
-- @number cover_h
-- @treturn table FrameContainer
local function coverBoxFor(page, cover_id, cover_w, cover_h)
    local inner_w = math.max(cover_w - 2, 1)
    local inner_h = math.max(cover_h - 2, 1)
    local cover = nil
    if type(page.cover_widget) == "function" then
        local ok, widget = pcall(page.cover_widget, cover_id, inner_w, inner_h)
        if ok and widget then cover = widget end
    end
    -- The slot is recorded whether it holds an image or the placeholder, and the
    -- box around it is the same size either way. That is what lets a cover
    -- arrive later WITHOUT relaying out the page: the frame is already the right
    -- size, so the image is swapped inside it and nothing on the glass moves.
    local holder = CenterContainer:new{
        dimen = Geom:new{ w = inner_w, h = inner_h },
        cover or label(Ui.GLYPH.cover, page.faces.row_small, { align = "center", color = COLOR_MUTED }),
    }
    page:registerCoverSlot(cover_id, holder, inner_w, inner_h)
    return FrameContainer:new{
        radius = Ui.tokens.corner_radius,
        bordersize = 1,
        padding = 0,
        color = COLOR_BORDER,
        background = cover and nil or COLOR_PLACEHOLDER_BG,
        holder,
    }
end

--- Builds one content row: cover, title, secondary line, bar, right column.
-- @tparam table self page
-- @tparam table row model row (see `lighthouse_views.lua`)
-- @number height row height
-- @treturn table widget
function PageWidget:buildRow(row, height)
    local plan = self.plan
    local width = plan.content_w
    local gutter = math.max(plan.gap, 6)
    local right_gap = math.max(plan.gap, 6)
    local right_w = math.max(math.floor(width * 0.16), 1)
    local cover_w = 0
    local cover_h = plan.reading_cover_h or height

    -- The reader's "Show cover thumbnails" preference decides whether a row
    -- reserves a cover column at all: turning it off must give the text the
    -- space back, not paint a placeholder where a picture used to be.
    if self.covers and row.kind == "reading" and type(self.cover_widget) == "function" then
        cover_w = plan.reading_cover_w or 0
    end

    local text_w = width - right_w - right_gap - (cover_w > 0 and (cover_w + gutter) or 0)
    if text_w < 1 then text_w = 1 end

    local title_face = self.faces.row_title
    local small_face = self.faces.row_small
    local sec_gap = math.max(math.floor(plan.gap / 4), 2)
    local bar_gap = math.max(math.floor(plan.gap / 2), 3)
    local content = VerticalGroup:new{
        align = "left",
        -- Rows lead in bold by default; a row that says otherwise (a recent
        -- session) keeps its own weight instead of being forced bold.
        label(row.title or "", title_face, { bold = row.bold ~= false, width = text_w }),
    }
    if row.secondary and row.secondary ~= "" then
        content[#content + 1] = VerticalSpan:new{ width = sec_gap }
        content[#content + 1] = label(row.secondary, small_face, { width = text_w, color = COLOR_MUTED })
    end
    if row.ratio ~= nil and height > (plan.bar + 2 * plan.gap) then
        local filled = Ui.barFill(row.ratio, text_w)
        content[#content + 1] = VerticalSpan:new{ width = bar_gap }
        content[#content + 1] = progressBar(filled, text_w, plan.bar)
    end

    local value_muted = row.kind == "reading" and row.ratio == nil
    local value_column = VerticalGroup:new{
        align = "right",
        label(row.value or "", self.faces.row_value, {
            bold = not value_muted,
            color = value_muted and COLOR_MUTED or COLOR_BLACK,
            width = right_w,
            align = "right",
        }),
    }
    if row.value_sub and row.value_sub ~= "" then
        value_column[#value_column + 1] = label(row.value_sub, small_face, {
            width = right_w,
            color = COLOR_MUTED,
            align = "right",
        })
    end

    local group = HorizontalGroup:new{ align = "center" }
    if cover_w > 0 then
        local cover_box = coverBoxFor(self, row.cover_id, cover_w, cover_h)
        group[#group + 1] = LeftContainer:new{
            dimen = Geom:new{ w = cover_w, h = height },
            cover_box,
        }
        group[#group + 1] = HorizontalSpan:new{ width = gutter }
    end
    group[#group + 1] = LeftContainer:new{ dimen = Geom:new{ w = text_w, h = height }, content }
    group[#group + 1] = HorizontalSpan:new{ width = right_gap }
    group[#group + 1] = RightContainer:new{ dimen = Geom:new{ w = right_w, h = height }, value_column }

    local focus_line = LineWidget:new{
        dimen = Geom:new{ w = width, h = plan.hairline },
        background = COLOR_DIVIDER,
    }
    local panel = Panel:new{
        child = VerticalGroup:new{ align = "left", group, focus_line },
        action = row.action,
        hold_action = row.hold_action,
        focus_line = focus_line,
    }
    if row.action then self:registerFocusable(panel) end
    return panel
end

--- Builds the Book Detail Card hero block: large cover + metadata + progress.
-- @tparam table self page
-- @tparam table block { cover_id, title, author, author_action, series, series_action, ... }
-- @treturn table widget
function PageWidget:buildBookHero(block)
    local plan = self.plan
    local width = plan.content_w
    local gutter = math.max(plan.gap or 8, 8)
    local sec_gap = math.max(math.floor((plan.gap or 8) / 3), 2)
    local line_h = plan.line_h or 20
    local cover_w = (self.covers and plan.cover_w and plan.cover_w > 0) and plan.cover_w or 0
    local cover_h = plan.cover_h or math.max((plan.hero_h or 120) - gutter, 1)
    local text_w = math.max(width - (cover_w > 0 and (cover_w + gutter) or 0), 1)
    local hero_h = math.max(plan.hero_h or cover_h, cover_h)

    -- The title is wrapped for the face it is DRAWN with, not for a size guessed
    -- from the page's leftover band. The old code measured with
    -- `floor(line_h * 0.72)` and then painted with `faces.row_title`, so on a K5
    -- it allotted 51 characters a 32 px line would hold and drew them at 22 px -
    -- 1.57x overflow, third line clipped off the glass.
    local title_px = tonumber(plan.row_title_px)
        or Ui.rowTitlePx(plan.reading_h or plan.row_h or line_h, plan.scale or 1)
    local title_chars = math.max(math.floor(text_w / math.max(title_px * 0.56, 6)), 14)
    local wrapped_title = Ui.wrapLines(block.title or "", title_chars, 3)
    local meta_stack = VerticalGroup:new{ align = "left" }
    local title_lines = #wrapped_title.lines > 0 and wrapped_title.lines or { block.title or "" }
    for idx = 1, #title_lines do
        meta_stack[#meta_stack + 1] = label(title_lines[idx], self.faces.row_title, { bold = true, width = text_w })
    end

    if block.author and block.author ~= "" then
        meta_stack[#meta_stack + 1] = VerticalSpan:new{ width = sec_gap }
        if block.author_action then
            local author_widget = LeftContainer:new{
                dimen = Geom:new{ w = text_w, h = line_h },
                label(block.author .. " " .. Ui.GLYPH.chevron, self.faces.row_small, {
                    bold = true,
                    width = text_w,
                    color = COLOR_BLACK,
                }),
            }
            local author_panel = Panel:new{
                child = author_widget,
                action = block.author_action,
            }
            self:register(author_panel)
            meta_stack[#meta_stack + 1] = author_panel
        else
            meta_stack[#meta_stack + 1] = label(block.author, self.faces.row_small, {
                width = text_w,
                color = COLOR_MUTED,
            })
        end
    end

    if block.series and block.series ~= "" then
        local series_text = block.series_action
            and (block.series .. " " .. Ui.GLYPH.chevron)
            or block.series
        if block.series_action then
            local series_widget = LeftContainer:new{
                dimen = Geom:new{ w = text_w, h = line_h },
                label(series_text, self.faces.row_small, { width = text_w, color = COLOR_MUTED }),
            }
            local series_panel = Panel:new{
                child = series_widget,
                action = block.series_action,
            }
            self:register(series_panel)
            meta_stack[#meta_stack + 1] = series_panel
        else
            meta_stack[#meta_stack + 1] = label(series_text, self.faces.row_small, {
                width = text_w,
                color = COLOR_MUTED,
            })
        end
    end

    local badge_line = Ui.join({ block.rating_stars, block.on_device_label })
    if badge_line ~= "" then
        meta_stack[#meta_stack + 1] = VerticalSpan:new{ width = sec_gap }
        meta_stack[#meta_stack + 1] = label(badge_line, self.faces.row_small, {
            width = text_w,
            color = COLOR_MUTED,
        })
    end

    if block.progress_ratio ~= nil then
        local filled = Ui.barFill(block.progress_ratio, text_w)
        meta_stack[#meta_stack + 1] = VerticalSpan:new{ width = sec_gap }
        meta_stack[#meta_stack + 1] = progressBar(filled, text_w, plan.bar or 6)
    end
    local progress_text = (block.progress_detail and block.progress_detail ~= "")
        and block.progress_detail
        or (block.progress_value or "")
    if progress_text ~= "" then
        meta_stack[#meta_stack + 1] = VerticalSpan:new{ width = sec_gap }
        meta_stack[#meta_stack + 1] = label(progress_text, self.faces.row_small, {
            width = text_w,
            color = block.progress_ratio ~= nil and COLOR_BLACK or COLOR_MUTED,
        })
    end
    if block.local_note and block.local_note ~= "" then
        meta_stack[#meta_stack + 1] = label(block.local_note, self.faces.footer, {
            width = text_w,
            color = COLOR_MUTED,
        })
    end

    local row = HorizontalGroup:new{ align = "top" }
    if cover_w > 0 then
        row[#row + 1] = LeftContainer:new{
            dimen = Geom:new{ w = cover_w, h = cover_h },
            coverBoxFor(self, block.cover_id, cover_w, cover_h),
        }
        row[#row + 1] = HorizontalSpan:new{ width = gutter }
    end
    row[#row + 1] = LeftContainer:new{
        dimen = Geom:new{ w = text_w, h = math.max(hero_h - sec_gap, cover_h) },
        meta_stack,
    }
    return LeftContainer:new{
        dimen = Geom:new{ w = width, h = hero_h },
        row,
    }
end

--- Renders a 1- or 2-row square action button bar inside Book Detail Card.
-- @tparam table self page
-- @tparam table block { buttons = { { label, action, primary, disabled }... } }
-- @treturn table widget
function PageWidget:buildActionBar(block)
    local plan = self.plan
    local width = plan.content_w
    local buttons = block.buttons or {}
    if #buttons == 0 then return VerticalSpan:new{ width = 0 } end

    local btn_h = plan.action_h or 36
    local thickness = plan.hairline or 1
    local btn_gap = math.max(math.floor(plan.gap or 8), 4)
    local row_gap = math.max(math.floor((plan.gap or 8) / 2), 3)
    local rows = {}
    if #buttons <= 2 then
        rows[1] = buttons
    else
        for idx = 1, #buttons, 2 do
            local pair = { buttons[idx] }
            if buttons[idx + 1] then pair[2] = buttons[idx + 1] end
            rows[#rows + 1] = pair
        end
    end

    local stack = VerticalGroup:new{ align = "left" }
    for r_idx = 1, #rows do
        local row_btns = rows[r_idx]
        local count = #row_btns
        local btn_w = math.max(math.floor((width - (count - 1) * btn_gap) / count), 1)
        local inner_w = math.max(btn_w - 2 * thickness, 1)
        local inner_h = math.max(btn_h - 2 * thickness, 1)
        local hgroup = HorizontalGroup:new{ align = "center" }
        for b_idx = 1, count do
            local btn = row_btns[b_idx]
            local is_primary = btn.primary == true
            local is_disabled = btn.disabled == true
            local fg = is_primary and COLOR_WHITE or (is_disabled and COLOR_MUTED or COLOR_BLACK)
            local bg = is_primary and COLOR_BLACK or COLOR_WHITE
            local border = is_primary and COLOR_BLACK or (is_disabled and COLOR_DIVIDER or COLOR_BORDER)
            local frame = FrameContainer:new{
                radius = Ui.tokens.corner_radius,
                bordersize = thickness,
                padding = 0,
                color = border,
                background = bg,
                CenterContainer:new{
                    dimen = Geom:new{ w = inner_w, h = inner_h },
                    label(btn.label or "", self.faces.heading, {
                        bold = not is_disabled,
                        color = fg,
                        width = inner_w,
                        align = "center",
                    }),
                },
            }
            if not is_disabled and type(btn.action) == "table" then
                local focus_line = LineWidget:new{
                    dimen = Geom:new{ w = btn_w, h = thickness },
                    background = COLOR_DIVIDER,
                }
                local panel = Panel:new{
                    child = VerticalGroup:new{ align = "left", frame, focus_line },
                    action = btn.action,
                    focus_line = focus_line,
                }
                self:registerFocusable(panel)
                hgroup[#hgroup + 1] = panel
            else
                hgroup[#hgroup + 1] = frame
            end
            if b_idx < count then
                hgroup[#hgroup + 1] = HorizontalSpan:new{ width = btn_gap }
            end
        end
        stack[#stack + 1] = hgroup
        if r_idx < #rows then
            stack[#stack + 1] = VerticalSpan:new{ width = row_gap }
        end
    end
    return stack
end

--- Renders wrapped synopsis / body lines, optional tags & device metadata.
-- @tparam table self page
-- @tparam table block { heading, lines, muted, tags, meta, action }
-- @treturn table widget
function PageWidget:buildTextBody(block)
    local plan = self.plan
    local width = plan.content_w
    local line_h = plan.line_h or 20
    local sec_gap = math.max(math.floor((plan.gap or 8) / 2), 2)
    local stack = VerticalGroup:new{ align = "left" }
    if block.heading then
        stack[#stack + 1] = self:buildSectionHeading(block.heading)
    end
    local body_color = block.muted and COLOR_MUTED or COLOR_BLACK
    local lines = block.lines or {}
    if #lines > 0 then
        local lines_group = VerticalGroup:new{ align = "left" }
        for idx = 1, #lines do
            local line = lines[idx]
            lines_group[#lines_group + 1] = LeftContainer:new{
                dimen = Geom:new{ w = width, h = line_h },
                -- Drawn with the same face the box was measured for. The box used
                -- to be sized from the face and the face painted at `row_small`,
                -- which is how a 36 px box ended up holding 17 px type.
                label(line == "" and " " or line, self.faces.body, {
                    width = width,
                    color = body_color,
                }),
            }
        end
        if type(block.action) == "table" then
            local body_panel = Panel:new{
                child = lines_group,
                action = block.action,
            }
            self:register(body_panel)
            stack[#stack + 1] = body_panel
        else
            stack[#stack + 1] = lines_group
        end
    end
    if block.tags and block.tags ~= "" then
        stack[#stack + 1] = VerticalSpan:new{ width = sec_gap }
        stack[#stack + 1] = label(block.tags, self.faces.footer, { width = width, color = COLOR_MUTED })
    end
    if block.meta and block.meta ~= "" then
        stack[#stack + 1] = label(block.meta, self.faces.footer, { width = width, color = COLOR_MUTED })
    end
    return stack
end

--- Renders one multi-line highlight quote card with note & chapter/page meta.
-- @tparam table self page
-- @tparam table row { lines, note, meta_left, meta_right, action }
-- @number height card height
-- @treturn table Panel
function PageWidget:buildQuoteRow(row, height)
    local plan = self.plan
    local width = plan.content_w
    local line_h = plan.line_h or 20
    local pad_v = math.max(math.floor((plan.gap or 8) / 2), 3)
    local stack = VerticalGroup:new{ align = "left" }
    local lines = row.lines or {}
    for idx = 1, #lines do
        stack[#stack + 1] = LeftContainer:new{
            dimen = Geom:new{ w = width, h = line_h },
            label(lines[idx], self.faces.row_small, { width = width, color = COLOR_BLACK }),
        }
    end
    if row.note and row.note ~= "" then
        stack[#stack + 1] = LeftContainer:new{
            dimen = Geom:new{ w = width, h = line_h },
            label(Ui.GLYPH.section .. " " .. row.note, self.faces.row_small, {
                width = width,
                color = COLOR_MUTED,
            }),
        }
    end
    local right_w = math.floor(width * 0.20)
    local left_w = math.max(width - right_w, 1)
    stack[#stack + 1] = VerticalSpan:new{ width = pad_v }
    stack[#stack + 1] = HorizontalGroup:new{
        align = "center",
        LeftContainer:new{
            dimen = Geom:new{ w = left_w, h = line_h },
            label(row.meta_left or "", self.faces.footer, { width = left_w, color = COLOR_MUTED }),
        },
        RightContainer:new{
            dimen = Geom:new{ w = right_w, h = line_h },
            label(row.meta_right or "", self.faces.footer, {
                bold = true,
                width = right_w,
                color = COLOR_BLACK,
                align = "right",
            }),
        },
    }
    local card = LeftContainer:new{
        dimen = Geom:new{ w = width, h = height },
        stack,
    }
    local focus_line = LineWidget:new{
        dimen = Geom:new{ w = width, h = plan.hairline },
        background = COLOR_DIVIDER,
    }
    local panel = Panel:new{
        child = VerticalGroup:new{ align = "left", card, focus_line },
        action = row.action,
        focus_line = focus_line,
    }
    if row.action then self:registerFocusable(panel) end
    return panel
end

--- Builds the pixel heatmap band with month axis and shade legend.
-- @tparam table self page
-- @tparam table block heatmap block { columns, months, legend } or raw columns
-- @treturn table widget
function PageWidget:buildHeatmap(block)
    local plan = self.plan
    local columns = type(block) == "table" and block.columns or block
    local widget = Heatmap:new{
        columns = columns,
        cell_w = plan.heat_cell_w,
        cell_h = plan.heat_cell_h,
        gap = plan.heat_gap,
    }
    local heat_box = LeftContainer:new{
        dimen = Geom:new{ w = plan.content_w, h = 7 * plan.heat_cell_h + 6 * plan.heat_gap },
        widget,
    }
    local legend_h = plan.heat_legend
    if not legend_h or legend_h < 1 then return heat_box end

    local width = plan.content_w
    local left_w = math.floor(width * 0.65)
    local right_w = math.max(width - left_w, 1)
    local months = type(block) == "table" and type(block.months) == "table" and block.months or {}
    local months_group = HorizontalGroup:new{ align = "center" }
    if #months > 0 then
        local step_w = math.floor(left_w / #months)
        for month_index = 1, #months do
            local tick_w = month_index == #months
                and math.max(left_w - (#months - 1) * step_w, 1)
                or math.max(step_w, 1)
            months_group[#months_group + 1] = LeftContainer:new{
                dimen = Geom:new{ w = tick_w, h = legend_h },
                label(months[month_index], self.faces.footer, { width = tick_w, color = COLOR_MUTED }),
            }
        end
    end

    local legend = type(block) == "table" and type(block.legend) == "table" and block.legend or {}
    local swatch_size = math.min(math.max(math.floor(legend_h * 0.45), 5), 14)
    local swatch_gap = math.max(math.min(plan.heat_gap, 4), 1)
    local text_gap = math.max(math.min(math.floor(plan.gap / 2), legend_h), 3)
    local legend_group = HorizontalGroup:new{ align = "center" }
    legend_group[#legend_group + 1] = label(legend.less or "Less", self.faces.footer, { color = COLOR_MUTED })
    legend_group[#legend_group + 1] = HorizontalSpan:new{ width = text_gap }
    for level = 0, 4 do
        legend_group[#legend_group + 1] = Rect:new{
            width = swatch_size,
            height = swatch_size,
            color = HEAT_COLORS[level] or COLOR_BLACK,
        }
        if level < 4 then
            legend_group[#legend_group + 1] = HorizontalSpan:new{ width = swatch_gap }
        end
    end
    legend_group[#legend_group + 1] = HorizontalSpan:new{ width = text_gap }
    legend_group[#legend_group + 1] = label(legend.more or "More", self.faces.footer, { color = COLOR_MUTED })

    local legend_row = HorizontalGroup:new{
        align = "center",
        LeftContainer:new{ dimen = Geom:new{ w = left_w, h = legend_h }, months_group },
        RightContainer:new{ dimen = Geom:new{ w = right_w, h = legend_h }, legend_group },
    }
    return VerticalGroup:new{
        align = "left",
        heat_box,
        legend_row,
    }
end

--- Builds the footer: a rule, then explicit Prev / Page / Next or stats footer.
-- @tparam table self page
-- @treturn table widget
--- Builds the running-batch band: what is downloading and how far it has got.
--
-- Without this the only sign that a batch was running was a notice laid over the
-- list, which the page then repainted away on the next cover fetch. The band is
-- part of the plan (`Ui.listPlan`'s `with_progress`), so the list gives up a row
-- for it rather than being painted on top of.
-- @tparam table self page
-- @tparam table progress { label, value, ratio, detail }
-- @treturn table widget
function PageWidget:buildProgress(progress)
    local plan = self.plan
    local width = plan.content_w
    local band_h = math.max((plan.progress_h or plan.subline_h or 34) - plan.hairline, 1)
    local text_h = math.max(math.floor(band_h * 0.6), 1)
    local bar_h = math.max(band_h - text_h - math.max(math.floor(plan.gap / 4), 2), 2)
    local value_w = math.floor(width * 0.34)
    local label_w = math.max(width - value_w, 1)
    local headline = HorizontalGroup:new{
        align = "center",
        LeftContainer:new{
            dimen = Geom:new{ w = label_w, h = text_h },
            label(progress.label or "", self.faces.row_small, { width = label_w, bold = true }),
        },
        RightContainer:new{
            dimen = Geom:new{ w = value_w, h = text_h },
            label(progress.value or "", self.faces.row_small, {
                width = value_w,
                align = "right",
                color = COLOR_MUTED,
            }),
        },
    }
    local ratio = tonumber(progress.ratio) or 0
    if ratio < 0 then ratio = 0 end
    if ratio > 1 then ratio = 1 end
    local filled = Ui.barFill(ratio, width)
    return VerticalGroup:new{
        align = "left",
        rule(width, plan.hairline, COLOR_DIVIDER),
        VerticalSpan:new{ width = math.max(math.floor(plan.gap / 4), 2) },
        headline,
        VerticalSpan:new{ width = math.max(math.floor(plan.gap / 4), 2) },
        progressBar(filled, width, bar_h),
    }
end

--- Builds the footer: a rule, then Prev / page / Next with the summary beside them.
--
-- Three targets and two facts have to share one band, so the band is divided by
-- role instead of by halves: Prev and Next keep a quarter each, and the centre
-- quarter is split between the page number and the right-hand summary. The old
-- split read `footer.next or footer.right`, so on every paged screen the right
-- quarter repeated the page number and the summary - "All books", "Grouped by
-- series", "%1 missing · %2 queued" - was never drawn at all. The page number
-- printed twice and the one line that told the reader what the list WAS was
-- silently dropped on every single page.
-- @tparam table self page
-- @treturn table widget
function PageWidget:buildFooter()
    local plan = self.plan
    local width = plan.content_w
    local footer = self.model.footer or {}
    local pager = self.model.pager
    local right_text = footerText(footer.right)

    if pager then
        local prev_w = math.floor(width * 0.22)
        local next_w = math.floor(width * 0.22)
        -- The summary only takes a share when there is one to draw; a footer
        -- with no summary keeps the page number centred.
        local summary_w = right_text ~= "" and math.floor(width * 0.28) or 0
        local center_w = math.max(width - prev_w - next_w - summary_w, 1)
        local has_prev = pager.has_prev == true
        local has_next = pager.has_next == true

        local prev_panel = Panel:new{
            child = LeftContainer:new{
                dimen = Geom:new{ w = prev_w, h = plan.footer },
                label(footer.prev or footer.left or "", self.faces.footer, {
                    bold = has_prev,
                    color = has_prev and COLOR_BLACK or COLOR_DIVIDER,
                    width = prev_w,
                }),
            },
            action = { kind = "footer_left" },
        }
        local center_panel = Panel:new{
            child = CenterContainer:new{
                dimen = Geom:new{ w = center_w, h = plan.footer },
                label(footer.center or footer.left or "", self.faces.footer, {
                    color = COLOR_MUTED,
                    width = center_w,
                    align = "center",
                }),
            },
            action = { kind = "page_jump", pager = pager },
        }
        local right_panel = Panel:new{
            child = RightContainer:new{
                dimen = Geom:new{ w = next_w, h = plan.footer },
                label(footer.next or "", self.faces.footer, {
                    bold = has_next,
                    color = has_next and COLOR_BLACK or COLOR_DIVIDER,
                    width = next_w,
                    align = "right",
                }),
            },
            action = { kind = "footer_right" },
        }
        self:register(prev_panel)
        self:register(center_panel)
        self:register(right_panel)
        local row = HorizontalGroup:new{ align = "center", prev_panel, center_panel }
        if summary_w > 0 then
            local summary_panel = Panel:new{
                child = CenterContainer:new{
                    dimen = Geom:new{ w = summary_w, h = plan.footer },
                    label(right_text, self.faces.footer, {
                        color = COLOR_MUTED,
                        width = summary_w,
                        align = "center",
                    }),
                },
                action = { kind = "page_jump", pager = pager },
            }
            self:register(summary_panel)
            row[#row + 1] = summary_panel
        end
        row[#row + 1] = right_panel
        -- What the footer says, for the renderer-level assertion: every label
        -- this footer drew is recorded, so a test can prove the summary reached
        -- the glass instead of trusting that the model carried it.
        self.footer_labels = { left = footer.prev or footer.left or "", center = footer.center or footer.left or "", summary = right_text, next = footer.next or "" }
        return VerticalGroup:new{
            align = "left",
            rule(width, plan.hairline, COLOR_DIVIDER),
            row,
        }
    end

    local half = math.floor(width / 2)
    local left_widget = label(footer.left or "", self.faces.footer, { width = half, color = COLOR_MUTED })
    local right_widget = label(footer.right or "", self.faces.footer, {
        width = width - half,
        color = COLOR_MUTED,
        align = "right",
    })
    self.footer_labels = { left = footer.left or "", right = footer.right or "" }
    return VerticalGroup:new{
        align = "left",
        rule(width, plan.hairline, COLOR_DIVIDER),
        HorizontalGroup:new{
            align = "center",
            LeftContainer:new{ dimen = Geom:new{ w = half, h = plan.footer }, left_widget },
            RightContainer:new{ dimen = Geom:new{ w = width - half, h = plan.footer }, right_widget },
        },
    }
end

--- Records a tappable panel and returns it.
-- @tparam table panel
-- @treturn table panel
function PageWidget:register(panel)
    self.panels = self.panels or {}
    self.panels[#self.panels + 1] = panel
    return panel
end

--- Records a cover frame so an image can be swapped into it later.
-- The holder's `paintTo` is wrapped to remember where it was last painted, so a
-- cover that arrives after the page was drawn can invalidate its own rectangle
-- instead of the whole panel. That is the difference between a screen that
-- flickers once per four covers and one that only repaints four small boxes.
-- @param cover_id number|nil book the slot belongs to
-- @tparam table holder the CenterContainer inside the frame
-- @number w inner width the image was sized for
-- @number h inner height the image was sized for
function PageWidget:registerCoverSlot(cover_id, holder, w, h)
    self.cover_slots = self.cover_slots or {}
    local slot = { id = cover_id, holder = holder, w = w, h = h }
    self.cover_slots[#self.cover_slots + 1] = slot
    if type(holder.paintTo) == "function" then
        local base_paint = holder.paintTo
        holder.paintTo = function(inner, bb, x, y)
            slot.x, slot.y = x, y
            return base_paint(inner, bb, x, y)
        end
    end
    return slot
end

--- The screen rectangles of every cover frame that has been painted.
-- Used to invalidate just the boxes a cover swap touched. A slot that has never
-- been painted has no coordinates and is left out; the caller falls back to the
-- whole page in that case.
-- @tparam[opt] table ids set of book ids to include; all slots when omitted
-- @treturn table array of Geom rectangles
function PageWidget:coverRects(ids)
    local rects = {}
    local slots = self.cover_slots
    if type(slots) ~= "table" then return rects end
    for slot_index = 1, #slots do
        local slot = slots[slot_index]
        local wanted = ids == nil or (slot.id ~= nil and ids[slot.id] == true)
        if wanted and type(slot.x) == "number" and type(slot.y) == "number" then
            -- Two pixels of slack cover the frame's own border, so the box the
            -- cover sits in is repainted with the image inside it.
            local inset = 2
            rects[#rects + 1] = Geom:new{
                x = slot.x - inset,
                y = slot.y - inset,
                w = slot.w + 2 * inset,
                h = slot.h + 2 * inset,
            }
        end
    end
    return rects
end

--- Swaps a fetched cover into every frame already holding that book's placeholder.
-- The frame's inner box is the size the image was fetched for, so this replaces
-- the contents of a fixed-size hole: no row moves, no face is rebuilt and the
-- page does not have to be laid out again. It is what makes a cover arriving
-- after the first paint cheap - the alternative was rebuilding all six rows and
-- repainting the whole e-ink panel once per four covers.
-- @param cover_id number|nil
-- @treturn number frames updated
function PageWidget:applyCover(cover_id)
    if cover_id == nil or type(self.cover_widget) ~= "function" then return 0 end
    local slots = self.cover_slots
    if type(slots) ~= "table" then return 0 end
    local applied = 0
    for slot_index = 1, #slots do
        local slot = slots[slot_index]
        if slot.id == cover_id then
            local ok, widget = pcall(self.cover_widget, cover_id, slot.w, slot.h)
            if ok and widget then
                slot.holder[1] = widget
                if slot.holder.resetLayout then slot.holder:resetLayout() end
                applied = applied + 1
            end
        end
    end
    return applied
end

--- Records a content row the key cycle can land on and returns it.
-- Only rows that draw a focus line join the cycle; chrome stays tappable.
-- @tparam table panel
-- @treturn table panel
function PageWidget:registerFocusable(panel)
    self:register(panel)
    self.focus_panels = self.focus_panels or {}
    self.focus_panels[#self.focus_panels + 1] = panel
    return panel
end

--- Builds the whole page as one widget tree.
function PageWidget:init()
    self.panels = {}
    self.focus_panels = {}
    self.faces = self.faces or buildFaces(self.plan)
    local plan = self.plan
    local width = plan.content_w

    local content = VerticalGroup:new{ align = "left" }
    content[#content + 1] = self:buildHeader()
    content[#content + 1] = rule(width, plan.hairline, COLOR_DIVIDER)

    if self.model.switch then
        content[#content + 1] = self:buildSwitch()
    end
    if self.model.subline then
        local subline = self.model.subline
        local sub_h = plan.subline_h or plan.section_head
        if subline.clear then
            local clear_w = math.floor(width * 0.18)
            local right_w = math.floor(width * 0.34)
            local left_w = math.max(width - clear_w - right_w, 1)
            local sub_row = HorizontalGroup:new{ align = "center" }
            sub_row[#sub_row + 1] = LeftContainer:new{
                dimen = Geom:new{ w = left_w, h = sub_h },
                label(subline.left or "", self.faces.row_small, { width = left_w, color = COLOR_MUTED }),
            }
            local clear_panel = Panel:new{
                child = LeftContainer:new{
                    dimen = Geom:new{ w = clear_w, h = sub_h },
                    label(subline.clear.label or "", self.faces.row_small, {
                        bold = true,
                        width = clear_w,
                        color = COLOR_BLACK,
                    }),
                },
                action = subline.clear.action,
            }
            self:register(clear_panel)
            sub_row[#sub_row + 1] = clear_panel
            local right_box = RightContainer:new{
                dimen = Geom:new{ w = right_w, h = sub_h },
                label(subline.right or "", self.faces.row_small, {
                    bold = subline.right_action ~= nil,
                    color = subline.right_action and COLOR_BLACK or COLOR_MUTED,
                    width = right_w,
                    align = "right",
                }),
            }
            if subline.right_action then
                local right_panel = Panel:new{
                    child = right_box,
                    action = subline.right_action,
                }
                self:register(right_panel)
                sub_row[#sub_row + 1] = right_panel
            else
                sub_row[#sub_row + 1] = right_box
            end
            content[#content + 1] = sub_row
        else
            local left_w = math.floor(width * 0.58)
            local right_w = math.max(width - left_w, 1)
            local sub_row = HorizontalGroup:new{ align = "center" }
            sub_row[#sub_row + 1] = LeftContainer:new{
                dimen = Geom:new{ w = left_w, h = sub_h },
                label(subline.left or "", self.faces.row_small, { width = left_w, color = COLOR_MUTED }),
            }
            local right_box = RightContainer:new{
                dimen = Geom:new{ w = right_w, h = sub_h },
                label(subline.right or "", self.faces.row_small, {
                    bold = subline.right_action ~= nil,
                    color = subline.right_action and COLOR_BLACK or COLOR_MUTED,
                    width = right_w,
                    align = "right",
                }),
            }
            if subline.right_action then
                local right_panel = Panel:new{
                    child = right_box,
                    action = subline.right_action,
                }
                self:register(right_panel)
                sub_row[#sub_row + 1] = right_panel
            else
                sub_row[#sub_row + 1] = right_box
            end
            content[#content + 1] = sub_row
        end
    end

    -- A running batch gets its own band: one label saying which volume is in
    -- flight and a bar saying how far the batch has got. It is a planned band,
    -- not an overlay, so it never paints over the first row of the list.
    if type(self.model.progress) == "table" then
        content[#content + 1] = self:buildProgress(self.model.progress)
    end

    local section_gap = plan.section_gap or math.max(math.floor((plan.gap or 8) / 2), 2)
    local blocks = self.model.blocks or {}
    for block_index = 1, #blocks do
        local block = blocks[block_index]
        if block.kind == "hero" then
            content[#content + 1] = self:buildHero(block.cells or {})
            content[#content + 1] = rule(width, plan.hairline, COLOR_DIVIDER)
        elseif block.kind == "band" then
            content[#content + 1] = self:buildBand(block.columns or {})
            content[#content + 1] = rule(width, plan.hairline, COLOR_DIVIDER)
        elseif block.kind == "section" then
            local rows = block.rows or {}
            -- A heading with no rows left is not drawn: an empty "RECENT
            -- SESSIONS" would read as a section that failed to load.
            if #rows > 0 then
                content[#content + 1] = VerticalSpan:new{ width = section_gap }
                content[#content + 1] = self:buildSectionHeading(block.heading or {})
                local height = block.row_kind == "session"
                    and (plan.session_h or plan.row_h)
                    or (plan.reading_h or plan.row_h)
                for row_index = 1, #rows do
                    content[#content + 1] = self:buildRow(rows[row_index], height)
                end
            end
        elseif block.kind == "heatmap" then
            content[#content + 1] = VerticalSpan:new{ width = section_gap }
            content[#content + 1] = self:buildSectionHeading(block.heading or {})
            content[#content + 1] = self:buildHeatmap(block)
        elseif block.kind == "list" then
            local rows = block.rows or {}
            for row_index = 1, #rows do
                content[#content + 1] = self:buildRow(rows[row_index], plan.row_h or 60)
            end
        elseif block.kind == "book_hero" then
            content[#content + 1] = VerticalSpan:new{ width = section_gap }
            content[#content + 1] = self:buildBookHero(block)
            content[#content + 1] = rule(width, plan.hairline, COLOR_DIVIDER)
        elseif block.kind == "action_bar" then
            content[#content + 1] = VerticalSpan:new{ width = section_gap }
            content[#content + 1] = self:buildActionBar(block)
        elseif block.kind == "text_body" then
            content[#content + 1] = VerticalSpan:new{ width = section_gap }
            content[#content + 1] = self:buildTextBody(block)
        elseif block.kind == "quote_list" then
            local rows = block.rows or {}
            for row_index = 1, #rows do
                content[#content + 1] = self:buildQuoteRow(rows[row_index], plan.row_h or 104)
            end
        end
    end

    -- The page is exactly one screen tall, whatever it happens to draw: a
    -- paged view that shrinks to its content leaves the tail of the previous
    -- page on the glass, because the repaint only covers what the new page
    -- paints. A page that draws a next-page row is a different height from the
    -- last page that does not, so the two pages are different heights unless the
    -- band is padded back out here. The filler
    -- is measured from the content that was actually built, so the footer lands
    -- on the bottom edge on every page and the painted region and the invalidated
    -- region are the same rectangle.
    local plan_height = math.floor(tonumber(plan.height) or 0)
    content[#content + 1] = self:buildFooter()
    if content.resetLayout then content:resetLayout() end
    local inner_height = plan_height - 2 * plan.pad
    local measured_ok, content_size = pcall(function() return content:getSize() end)
    local content_height = measured_ok and tonumber(content_size and content_size.h) or nil
    local filler = content_height and (inner_height - content_height) or nil
    -- No measurement: the plan's leftover is the best evidence of where the
    -- bottom edge is. A measured overflow is the other case - the content is
    -- already taller than the page, so padding it would only push the footer
    -- further past the edge.
    if not filler then
        filler = math.max(plan.slack or 0, 0)
    elseif filler < 0 then
        filler = 0
    end
    -- The filler goes above the footer, so the footer keeps the bottom edge.
    table.insert(content, #content, VerticalSpan:new{ width = filler })
    if content.resetLayout then content:resetLayout() end

    self.widget = FrameContainer:new{
        radius = Ui.tokens.corner_radius,
        bordersize = 0,
        padding = plan.pad,
        margin = 0,
        background = COLOR_WHITE,
        content,
    }
    self.dimen = self.widget:getSize()

    self.ges_events = {
        TapSelect = {
            GestureRange:new{ ges = "tap", range = function() return self.dimen end },
        },
        HoldSelect = {
            GestureRange:new{ ges = "hold", range = function() return self.dimen end },
        },
        Swipe = {
            GestureRange:new{ ges = "swipe", range = function() return self.dimen end },
        },
    }

    if Device and Device.hasKeys and Device:hasKeys() then
        local group = Device.input and Device.input.group
        local function keyList(...)
            local list, seen = {}, {}
            for key_index = 1, select("#", ...) do
                local key = select(key_index, ...)
                if type(key) == "string" and key ~= "" and not seen[key] then
                    seen[key] = true
                    list[#list + 1] = { key }
                end
            end
            return list
        end
        self.key_events = {
            Close = { { group and group.Back or "Back" } },
            NextItem = { { "Down" } },
            PrevItem = { { "Up" } },
            NextPage = keyList(group and group.PgFwd or "PgFwd", "RPgFwd", "LPgFwd"),
            PrevPage = keyList(group and group.PgBack or "PgBack", "RPgBack", "LPgBack"),
            SelectItem = { { "Press" }, { "Right" }, { "Return" } },
        }
    else
        self.key_events = {
            Close = { { Device.input and Device.input.group and Device.input.group.Back or "Back" } },
        }
    end
end

function PageWidget:getSize()
    return self.widget:getSize()
end

function PageWidget:paintTo(bb, x, y)
    self.widget:paintTo(bb, x, y)
    self.dimen.x, self.dimen.y = x, y
end

--- Runs one row action through the caller's dispatcher.
-- @tparam table action model action
function PageWidget:run(action)
    if type(action) ~= "table" then return end
    if action.kind == "back" then
        self:onBack()
    elseif action.kind == "overflow" then
        if type(self.on_overflow) == "function" then self.on_overflow(action) else self:onBack() end
    elseif action.kind == "switch" then
        if type(self.on_switch) == "function" then self.on_switch(action.key) end
    elseif action.kind == "footer_left" or action.kind == "footer_right" then
        -- The footer's halves turn the page, like the menu's own chevrons: each
        -- half is inert at the end it would step past.
        local pager = self.model.pager
        local step = action.kind == "footer_right" and 1 or -1
        local target = pager and (pager.page + step) or nil
        if target and target >= 1 and target <= pager.pages
            and type(self.on_action) == "function" then
            self.on_action({ kind = "page", page = target })
        end
    elseif type(self.on_action) == "function" then
        self.on_action(action)
    end
end

--- Touch: the top-most containing row wins.
-- Panels are registered in reading order, and rows never overlap, so the first
-- hit in reverse order is also the visually top-most one.
-- KOReader hands a gesture handler the zone's own arguments first and the input
-- event second; a build that sends only the event is still understood.
function PageWidget:onTapSelect(event_arg, ges)
    if type(ges) ~= "table" or ges.pos == nil then ges = event_arg end
    if not ges or not ges.pos or not self.panels then return false end
    local hit = self:panelAt(ges.pos)
    if not hit then return false end
    if hit.focus_line then
        if self.focus_index and self.focus_panels and self.focus_panels[self.focus_index] then
            self.focus_panels[self.focus_index]:setFocused(false)
        end
        hit:setFocused(true)
    end
    self:run(hit.action)
    return true
end

--- The panel a point lands on: exact rectangles first, then a forgiving halo.
--
-- The exact pass is the contract and stays first, so a tap inside two adjacent
-- rows still picks the one it is actually in. What the halo adds is the miss
-- that used to be swallowed in silence: the footer controls and the grouping
-- switch are the smallest things on the page, and a tap a millimetre above or
-- below one of them hit nothing at all - the page did not even register the
-- touch, so the reader concluded the plugin was broken. The halo never overrides
-- an exact hit, and the panel whose body is nearest the touch wins, so a miss
-- between two rows goes to the closer one rather than to whichever was
-- registered last.
-- @tparam table pos Geom point
-- @treturn table|nil panel
function PageWidget:panelAt(pos)
    local panels = self.panels or {}
    for panel_index = #panels, 1, -1 do
        local panel = panels[panel_index]
        if panel.dimen and pos:intersectWith(panel.dimen) then return panel end
    end

    local scale = (self.plan and self.plan.scale) or 1
    local slack_y = math.max(math.floor(7 * scale + 0.5), 4)
    local slack_x = math.max(math.floor(4 * scale + 0.5), 3)
    local best, best_distance
    for panel_index = #panels, 1, -1 do
        local panel = panels[panel_index]
        local dimen = panel.dimen
        if dimen then
            local x, y = tonumber(dimen.x), tonumber(dimen.y)
            local w, h = tonumber(dimen.w), tonumber(dimen.h)
            if x and y and w and h then
                local x0, y0 = x - slack_x, y - slack_y
                local x1, y1 = x + w + slack_x, y + h + slack_y
                local px, py = pos.x, pos.y
                if px >= x0 and px <= x1 and py >= y0 and py <= y1 then
                    local dx = math.max(x0 - px, px - x1, 0)
                    local dy = math.max(y0 - py, py - y1, 0)
                    local distance = dy * 1000 + dx
                    if not best_distance or distance < best_distance then
                        best, best_distance = panel, distance
                    end
                end
            end
        end
    end
    return best
end

--- Long-press: dispatches row quick actions when registered.
function PageWidget:onHoldSelect(event_arg, ges)
    if type(ges) ~= "table" or ges.pos == nil then ges = event_arg end
    if not ges or not ges.pos or not self.panels then return false end
    for panel_index = #self.panels, 1, -1 do
        local panel = self.panels[panel_index]
        if panel.dimen and ges.pos:intersectWith(panel.dimen) then
            local target = panel.hold_action or panel.action
            if target and type(self.on_hold) == "function" then
                if panel.focus_line then
                    if self.focus_index and self.focus_panels and self.focus_panels[self.focus_index] then
                        self.focus_panels[self.focus_index]:setFocused(false)
                    end
                    panel:setFocused(true)
                end
                self.on_hold(target, panel)
                return true
            end
        end
    end
    return false
end

--- Swipe: left/right turn the page of a paged view.
function PageWidget:onSwipe(event_arg, ges)
    if type(ges) ~= "table" or ges.direction == nil then ges = event_arg end
    if type(ges) ~= "table" then return end
    local direction = ges.direction
    local pager = self.model and self.model.pager
    if not pager or type(self.on_action) ~= "function" then return end
    if direction == "west" or direction == "east" then
        local step = direction == "west" and 1 or -1
        local target = pager.page + step
        if target >= 1 and target <= pager.pages then
            self.on_action({ kind = "page", page = target })
        end
    end
end

--- Keys: move the focus line between the content rows.
-- @number step -1 for previous, 1 for next
function PageWidget:moveFocus(step)
    local panels = self.focus_panels
    if not panels or #panels == 0 then return end
    local count = #panels
    local current = self.focus_index or 0
    local next_index = current + step
    if next_index < 1 then next_index = count end
    if next_index > count then next_index = 1 end
    if self.focus_index and panels[self.focus_index] then
        panels[self.focus_index]:setFocused(false)
    end
    self.focus_index = next_index
    panels[next_index]:setFocused(true)
end

function PageWidget:onNextItem()
    self:moveFocus(1)
    return true
end

function PageWidget:onPrevItem()
    self:moveFocus(-1)
    return true
end

function PageWidget:onNextPage()
    if self.model and self.model.pager then
        self:run({ kind = "footer_right" })
        return true
    end
    self:moveFocus(1)
    return true
end

function PageWidget:onPrevPage()
    if self.model and self.model.pager then
        self:run({ kind = "footer_left" })
        return true
    end
    self:moveFocus(-1)
    return true
end

function PageWidget:onSelectItem()
    local panels = self.focus_panels or {}
    if self.focus_index and panels[self.focus_index] then
        self:run(panels[self.focus_index].action)
    end
    return true
end

--- Back: the header's back mark, the Back key and a tap outside all arrive
-- here.
--
-- The caller owns what Back means (`on_back`): a nested view goes up one level
-- to the view it was opened from, and the top level leaves the plugin. A build
-- without that handler keeps the old behaviour and simply closes, so nothing
-- outside the plugin can be broken by a page it did not open.
function PageWidget:onBack()
    if type(self.on_back) == "function" then
        self.on_back()
        return true
    end
    UIManager:close(self)
    if type(self.close_callback) == "function" then self.close_callback() end
    return true
end

function PageWidget:onClose()
    return self:onBack()
end

function PageWidget:onCloseWidget()
    if self.widget and type(self.widget.free) == "function" then
        pcall(self.widget.free, self.widget)
    end
end

--- Builds one page widget from a model and its layout plan.
-- @tparam table options { model, plan, cover_widget, on_action,
--                         on_overflow, on_switch, on_back, close_callback }
-- @treturn table page widget
function Page.build(options)
    options = options or {}
    local widget = PageWidget:new{
        model = options.model,
        plan = options.plan,
        faces = options.faces,
        cover_widget = options.cover_widget,
        covers = options.covers ~= false,
        on_action = options.on_action,
        on_hold = options.on_hold,
        on_overflow = options.on_overflow,
        on_switch = options.on_switch,
        on_back = options.on_back,
        close_callback = options.close_callback,
    }
    return widget
end

return Page
