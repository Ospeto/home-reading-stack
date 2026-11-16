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
    Back closes - so a Kindle with a 5-way controller is as usable as a
    Paperwhite.
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

-- E-ink palette. Every one of these has a hard fallback, because a build that
-- lacks the shade must get a readable page rather than a raise in the paint
-- pass, where nothing can catch it.
local COLOR_BLACK = Blitbuffer.COLOR_BLACK
local COLOR_WHITE = Blitbuffer.COLOR_WHITE
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
    self.focus_line.background = focused and COLOR_BLACK or COLOR_WHITE
    UIManager:setDirty(self, "ui")
end

-- ----------------------------------------------------------------------------
-- Text helpers
-- ----------------------------------------------------------------------------

local face_cache = {}

--- One font face, cached per name and size.
-- Repeated pages ask for the same handful of faces (title, secondary, heading,
-- value); building a face is the expensive part of a page, so it happens once.
-- @string name KOReader font-map key
-- @number size pixel size
-- @treturn table|nil face
local function face(name, size)
    local pixels = math.floor(tonumber(size) or 0)
    if pixels < 8 then pixels = 8 end
    local key = name .. ":" .. tostring(pixels)
    local cached = face_cache[key]
    if cached ~= nil then return cached or nil end
    local ok, built = pcall(Font.getFace, Font, name, pixels)
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
-- @treturn table LineWidget
local function rule(width, thickness)
    return LineWidget:new{
        dimen = Geom:new{ w = math.max(width, 1), h = math.max(thickness, 1) },
        background = COLOR_BLACK,
    }
end

--- A vertical rule between two columns.
-- @number height
-- @number thickness
-- @treturn table Rect
local function column_rule(height, thickness)
    return Rect:new{ width = math.max(thickness, 1), height = math.max(height, 1), color = COLOR_BLACK }
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
    on_overflow = nil,
    on_switch = nil,
    cover_widget = nil,
    dimen = nil,
}

--- Font faces for one page, sized from the plan so the type scale follows the
--- screen instead of a table of magic numbers.
--
-- Both plans (`Ui.pagePlan` for the statistics page, `Ui.listPlan` for the
-- library) feed this, and they carry different bands, so every measure falls
-- back to a section-sized value rather than assuming the other screen's plan.
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
    local row_title = math.floor(math.min(plan.reading_h or plan.row_h or 88, 120) * 0.26)
    local row_small = math.max(row_title - math.floor(scale * 3), 11)
    local footer = math.max(math.floor((plan.footer or 26) * 0.6), 9)
    return {
        header = face("cfont", header),
        title = face("cfont", math.floor(plan.header * 0.52)),
        heading = face("cfont", heading),
        band_head = face("cfont", band_head),
        hero_label = face("cfont", hero_label),
        hero_value = face("cfont", hero_value),
        row_title = face("cfont", math.max(row_title, 12)),
        row_small = face("cfont", math.max(row_small, 10)),
        row_value = face("cfont", math.max(row_title, 12)),
        footer = face("cfont", math.max(footer, 10)),
    }
end

--- Builds the header row: back, title, overflow.
-- @tparam table self page
-- @treturn table widget
function PageWidget:buildHeader()
    local plan = self.plan
    local width = plan.content_w
    local third = math.floor(width / 3)
    local back = LeftContainer:new{
        dimen = Geom:new{ w = third, h = plan.header },
        label(Ui.GLYPH.back, self.faces.header, { width = third }),
    }
    local title = CenterContainer:new{
        dimen = Geom:new{ w = width - 2 * third, h = plan.header },
        label(self.model.title or "", self.faces.title, { bold = true, width = width - 2 * third }),
    }
    local overflow = RightContainer:new{
        dimen = Geom:new{ w = third, h = plan.header },
        label(Ui.GLYPH.overflow, self.faces.header, { width = third, align = "right" }),
    }
    -- The two header affordances are rows too, so touch reaches them the same
    -- way it reaches any other tappable line. They carry no focus line: chrome
    -- that cannot show focus stays out of the key cycle.
    local back_panel = Panel:new{
        child = back,
        action = { kind = "back" },
    }
    local overflow_panel = Panel:new{
        child = overflow,
        action = { kind = "overflow" },
    }
    self:register(back_panel)
    self:register(overflow_panel)
    return HorizontalGroup:new{
        align = "center",
        back_panel,
        title,
        overflow_panel,
    }
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
            group[#group + 1] = column_rule(plan.switch_h, thickness)
        end
    end
    return VerticalGroup:new{
        align = "center",
        rule(width, thickness),
        group,
        rule(width, thickness),
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
    local group = HorizontalGroup:new{ align = "top" }
    for cell_index = 1, count do
        local cell = cells[cell_index] or { label = "", value = "" }
        local content = VerticalGroup:new{
            align = "left",
            label(cell.label, self.faces.hero_label, { width = cell_w }),
            label(cell.value, self.faces.hero_value, { bold = true, width = cell_w }),
        }
        group[#group + 1] = LeftContainer:new{
            dimen = Geom:new{ w = cell_w, h = plan.hero },
            content,
        }
        if cell_index < count then group[#group + 1] = column_rule(plan.hero, thickness) end
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

    local first = columns[1] or { rows = {} }
    local second = columns[2]
    local band = VerticalGroup:new{ align = "left" }
    local head_row = HorizontalGroup:new{ align = "top" }
    for column_index = 1, count do
        local column = columns[column_index] or { rows = {} }
        head_row[#head_row + 1] = LeftContainer:new{
            dimen = Geom:new{ w = column_w, h = plan.band_head },
            label(column.heading or "", self.faces.band_head, { bold = true, width = column_w }),
        }
        if column_index < count then head_row[#head_row + 1] = column_rule(plan.band_head, thickness) end
    end
    band[#band + 1] = head_row

    local row_count = math.max(#first.rows, second and #second.rows or 0)
    for row_index = 1, row_count do
        local group = HorizontalGroup:new{ align = "top" }
        for column_index = 1, count do
            local column = columns[column_index] or { rows = {} }
            local entry = column.rows[row_index]
            local cell = HorizontalGroup:new{ align = "center" }
            if entry then
                cell[#cell + 1] = LeftContainer:new{
                    dimen = Geom:new{ w = math.floor((column_w - plan.gap) * 0.62), h = plan.band_row },
                    label(entry.label or "", self.faces.row_small, {
                        width = math.floor((column_w - plan.gap) * 0.62),
                    }),
                }
                cell[#cell + 1] = RightContainer:new{
                    dimen = Geom:new{
                        w = column_w - math.floor((column_w - plan.gap) * 0.62),
                        h = plan.band_row,
                    },
                    label(entry.value or "", self.faces.row_value, {
                        bold = true,
                        width = column_w - math.floor((column_w - plan.gap) * 0.62),
                        align = "right",
                    }),
                }
            end
            group[#group + 1] = LeftContainer:new{
                dimen = Geom:new{ w = column_w, h = plan.band_row },
                cell,
            }
            if column_index < count then group[#group + 1] = column_rule(plan.band_row, thickness) end
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
    local left_widget = label(heading.left or "", self.faces.heading, { bold = true, width = left_w })
    local right_widget = label(heading.right or "", self.faces.heading, {
        bold = true,
        width = right_w,
        align = "right",
    })
    return HorizontalGroup:new{
        align = "center",
        LeftContainer:new{ dimen = Geom:new{ w = left_w, h = plan.section_head }, left_widget },
        RightContainer:new{ dimen = Geom:new{ w = right_w, h = plan.section_head }, right_widget },
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
    local gutter = math.floor(plan.gap / 2)
    local right_w = math.max(math.floor(width * 0.22), 1)
    local cover_w = 0
    local cover = nil

    if row.kind == "reading" and type(self.cover_widget) == "function" then
        cover_w = plan.reading_cover_w or 0
        local ok, widget = pcall(self.cover_widget, row.cover_id, cover_w, plan.reading_cover_h or 0)
        if ok and widget then cover = widget end
    end

    local text_w = width - right_w - (cover_w > 0 and (cover_w + gutter) or 0)
    if text_w < 1 then text_w = 1 end

    local title_face = self.faces.row_title
    local small_face = self.faces.row_small
    local content = VerticalGroup:new{
        align = "left",
        label(row.title or "", title_face, { bold = true, width = text_w }),
    }
    if row.secondary and row.secondary ~= "" then
        content[#content + 1] = label(row.secondary, small_face, { width = text_w })
    end
    if row.ratio ~= nil and height > (plan.bar + 2 * plan.gap) then
        local filled = Ui.barFill(row.ratio, text_w)
        content[#content + 1] = VerticalSpan:new{ width = plan.hairline }
        content[#content + 1] = progressBar(filled, text_w, plan.bar)
    end

    local value_column = VerticalGroup:new{
        align = "right",
        label(row.value or "", self.faces.row_value, {
            bold = true,
            width = right_w,
            align = "right",
        }),
    }
    if row.value_sub and row.value_sub ~= "" then
        value_column[#value_column + 1] = label(row.value_sub, small_face, {
            width = right_w,
            align = "right",
        })
    end

    local group = HorizontalGroup:new{ align = "center" }
    if cover_w > 0 then
        if cover then
            group[#group + 1] = LeftContainer:new{
                dimen = Geom:new{ w = cover_w, h = height },
                cover,
            }
        else
            group[#group + 1] = LeftContainer:new{
                dimen = Geom:new{ w = cover_w, h = height },
                FrameContainer:new{
                    radius = Ui.tokens.corner_radius,
                    bordersize = plan.hairline,
                    padding = 0,
                    CenterContainer:new{
                        dimen = Geom:new{
                            w = math.max(cover_w - 2 * plan.hairline, 1),
                            h = math.max((plan.reading_cover_h or height) - 2 * plan.hairline, 1),
                        },
                        label(Ui.GLYPH.cover, self.faces.row_small, { align = "center" }),
                    },
                },
            }
        end
        group[#group + 1] = HorizontalSpan:new{ width = gutter }
    end
    group[#group + 1] = LeftContainer:new{ dimen = Geom:new{ w = text_w, h = height }, content }
    group[#group + 1] = RightContainer:new{ dimen = Geom:new{ w = right_w, h = height }, value_column }

    local focus_line = LineWidget:new{
        dimen = Geom:new{ w = width, h = plan.hairline },
        background = COLOR_WHITE,
    }
    local panel = Panel:new{
        child = VerticalGroup:new{ align = "left", group, focus_line },
        action = row.action,
        focus_line = focus_line,
    }
    if row.action then self:registerFocusable(panel) end
    return panel
end

--- Builds the pixel heatmap band.
-- @tparam table self page
-- @tparam table columns heatmap columns from `Ui.heatmapColumns`
-- @treturn table widget
function PageWidget:buildHeatmap(columns)
    local plan = self.plan
    local widget = Heatmap:new{
        columns = columns,
        cell_w = plan.heat_cell_w,
        cell_h = plan.heat_cell_h,
        gap = plan.heat_gap,
    }
    return LeftContainer:new{
        dimen = Geom:new{ w = plan.content_w, h = 7 * plan.heat_cell_h + 6 * plan.heat_gap },
        widget,
    }
end

--- Builds the footer: a rule, then the two footer texts.
-- @tparam table self page
-- @treturn table widget
function PageWidget:buildFooter()
    local plan = self.plan
    local width = plan.content_w
    local footer = self.model.footer or {}
    local half = math.floor(width / 2)
    local left_widget = label(footer.left or "", self.faces.footer, { width = half })
    local right_widget = label(footer.right or "", self.faces.footer, {
        width = width - half,
        align = "right",
    })
    local left_panel = Panel:new{
        child = LeftContainer:new{ dimen = Geom:new{ w = half, h = plan.footer }, left_widget },
        action = { kind = "footer_left" },
    }
    local right_panel = Panel:new{
        child = RightContainer:new{
            dimen = Geom:new{ w = width - half, h = plan.footer },
            right_widget,
        },
        action = { kind = "footer_right" },
    }
    if self.model.pager then
        self:register(left_panel)
        self:register(right_panel)
    end
    return VerticalGroup:new{
        align = "left",
        rule(width, plan.hairline),
        HorizontalGroup:new{ align = "center", left_panel, right_panel },
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
    content[#content + 1] = rule(width, plan.hairline)

    if self.model.switch then
        content[#content + 1] = self:buildSwitch()
    end
    if self.model.subline then
        local subline = self.model.subline
        local half = math.floor(width / 2)
        content[#content + 1] = HorizontalGroup:new{
            align = "center",
            LeftContainer:new{
                dimen = Geom:new{ w = half, h = plan.subline_h or plan.section_head },
                label(subline.left or "", self.faces.row_small, { width = half }),
            },
            RightContainer:new{
                dimen = Geom:new{ w = width - half, h = plan.subline_h or plan.section_head },
                label(subline.right or "", self.faces.row_small, {
                    width = width - half,
                    align = "right",
                }),
            },
        }
    end

    local blocks = self.model.blocks or {}
    for block_index = 1, #blocks do
        local block = blocks[block_index]
        if block.kind == "hero" then
            content[#content + 1] = self:buildHero(block.cells or {})
            content[#content + 1] = rule(width, plan.hairline)
        elseif block.kind == "band" then
            content[#content + 1] = self:buildBand(block.columns or {})
            content[#content + 1] = rule(width, plan.hairline)
        elseif block.kind == "section" then
            local rows = block.rows or {}
            -- A heading with no rows left is not drawn: an empty "RECENT
            -- SESSIONS" would read as a section that failed to load.
            if #rows > 0 then
                content[#content + 1] = self:buildSectionHeading(block.heading or {})
                local height = block.row_kind == "session"
                    and (plan.session_h or plan.row_h)
                    or (plan.reading_h or plan.row_h)
                for row_index = 1, #rows do
                    content[#content + 1] = self:buildRow(rows[row_index], height)
                end
            end
        elseif block.kind == "heatmap" then
            content[#content + 1] = self:buildSectionHeading(block.heading or {})
            content[#content + 1] = self:buildHeatmap(block.columns or {})
        elseif block.kind == "list" then
            local rows = block.rows or {}
            for row_index = 1, #rows do
                content[#content + 1] = self:buildRow(rows[row_index], plan.row_h or 60)
            end
        end
    end

    -- The footer sits at the bottom of the screen: the slack between the last
    -- band and the rule is one empty block rather than a page of scrolling.
    content[#content + 1] = VerticalSpan:new{ width = math.max(plan.slack or 0, 0) }
    content[#content + 1] = self:buildFooter()

    self.widget = FrameContainer:new{
        radius = Ui.tokens.corner_radius,
        bordersize = plan.hairline,
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
        Swipe = {
            GestureRange:new{ ges = "swipe", range = function() return self.dimen end },
        },
    }

    if Device and Device.hasKeys and Device:hasKeys() then
        local group = Device.input and Device.input.group
        self.key_events = {
            Close = { { group and group.Back or "Back" } },
            NextItem = { { "Down" }, { group and group.PgFwd or "PgFwd" } },
            PrevItem = { { "Up" }, { group and group.PgBack or "PgBack" } },
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
    for panel_index = #self.panels, 1, -1 do
        local panel = self.panels[panel_index]
        if panel.dimen and ges.pos:intersectWith(panel.dimen) then
            self:run(panel.action)
            return true
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

function PageWidget:onSelectItem()
    local panels = self.focus_panels or {}
    if self.focus_index and panels[self.focus_index] then
        self:run(panels[self.focus_index].action)
    end
    return true
end

function PageWidget:onBack()
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
--                         on_overflow, on_switch, close_callback }
-- @treturn table page widget
function Page.build(options)
    options = options or {}
    local widget = PageWidget:new{
        model = options.model,
        plan = options.plan,
        faces = options.faces,
        cover_widget = options.cover_widget,
        on_action = options.on_action,
        on_overflow = options.on_overflow,
        on_switch = options.on_switch,
        close_callback = options.close_callback,
    }
    return widget
end

return Page
