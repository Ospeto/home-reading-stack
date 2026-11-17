--[[--
The plugin's navigation stack: one entry per level the reader is on.

Before this module the plugin had no notion of a level at all. Every screen was
drawn into whichever widget happened to be free - a page replaced the page, a
menu swapped its item table - so the only thing left of the screen the reader
came from was nothing. Back therefore could only mean "leave the plugin", which
on a Kindle means the file manager: from inside one series' books the series
list was unreachable, and the header's back mark, the one affordance the
statistics page already drew, exited instead of going up.

One model replaces that, for every screen:

  * an entry describes where the reader IS - `kind` (what sort of screen),
    `key` (which one of them) and `state` (what to put back) - and carries the
    `render` function that draws it again;
  * showing an entry with the same kind and key as the one on the glass
    REPLACES it, because the reader has not gone anywhere: a page turn, a
    grouping switch and a refresh are all the same level;
  * showing any other entry PUSHES a level, because the reader has gone one
    step deeper - one series' books, one author's books, a search, a book's
    detail view, a different top-level screen;
  * going back pops one level and renders it again, with the state it was left
    in, and popping the last level leaves the plugin exactly as it always did.

That is the whole rule, and it is the same rule for a page and for a menu. The
module itself is pure Lua - no widgets, no sockets, no KOReader - so the
repository's off-device suite drives it directly.

@module koplugin.lighthouse_nav
]]

local Nav = {}

--- How many levels are remembered.
--
-- A reader cannot reach this many: the library nests one level (a filtered
-- list) below its grouping, and every other screen is a top-level entry. The
-- cap is a backstop so a long session on a device that never restarts cannot
-- grow a table without bound; when it is reached the OLDEST level is dropped,
-- which only means the earliest screen of the session stops being remembered.
Nav.MAX_DEPTH = 12

--- Whether two entries are the same level.
-- Kind and key only: two visits to one series' books are one level, so the
-- second replaces the first instead of stacking a duplicate the reader would
-- have to go back through twice.
-- @tparam table|nil a
-- @tparam table|nil b
-- @treturn boolean
function Nav.same(a, b)
    if type(a) ~= "table" or type(b) ~= "table" then return false end
    return a.kind == b.kind and a.key == b.key
end

--- The level the reader is on, or nil at the top.
-- @tparam table stack
-- @treturn table|nil entry
function Nav.top(stack)
    if type(stack) ~= "table" then return nil end
    return stack[#stack]
end

--- How deep the reader is.
-- @tparam table stack
-- @treturn number
function Nav.depth(stack)
    if type(stack) ~= "table" then return 0 end
    return #stack
end

--- Shows one entry: replaces the current level when it is the same level,
-- pushes a new one when it is a step deeper.
-- @tparam table stack the plugin's stack, mutated in place
-- @tparam table entry { kind, key, state, render }
-- @treturn string|nil "replaced", "pushed", or nil when the entry is not usable
function Nav.show(stack, entry)
    if type(stack) ~= "table" or type(entry) ~= "table" then return nil end
    if type(entry.kind) ~= "string" or entry.kind == "" then return nil end
    if entry.key == nil then entry.key = "" end
    local current = stack[#stack]
    if Nav.same(current, entry) then
        stack[#stack] = entry
        return "replaced"
    end
    stack[#stack + 1] = entry
    while #stack > Nav.MAX_DEPTH do
        table.remove(stack, 1)
    end
    return "pushed"
end

--- Goes up one level: drops the level the reader is on and returns the one
-- below it, which is what the caller then renders.
-- Nothing is dropped when the stack is empty, so a stray back press on a screen
-- the plugin did not open is not a navigation.
-- @tparam table stack
-- @treturn table|nil the level to render, or nil when the reader was at the top
function Nav.up(stack)
    if type(stack) ~= "table" or #stack == 0 then return nil end
    table.remove(stack)
    return stack[#stack]
end

--- Forgets every level.
-- Called when the plugin is left: the next visit starts at the top level
-- instead of inheriting the last session's chain.
-- @tparam table stack
function Nav.reset(stack)
    if type(stack) ~= "table" then return end
    for index = #stack, 1, -1 do
        stack[index] = nil
    end
end

--- Trims a search or grouping filter to what the server is asked for.
-- The same query text is one level however it was typed, with or without the
-- spaces around it.
-- @string[opt] query
-- @treturn string
function Nav.cleanQuery(query)
    if type(query) ~= "string" then return "" end
    return (query:gsub("^%s+", ""):gsub("%s+$", ""))
end

--- The key of one library view.
--
-- A list filtered to one series, one author or one search is a level BELOW the
-- groupings: the groupings (Books / Authors / Series) and their pages are the
-- top level, so switching grouping or turning a page stays where the reader is
-- and Back from any of them still leaves the plugin.
-- @string[opt] query
-- @treturn string
function Nav.libraryKey(query)
    local cleaned = Nav.cleanQuery(query)
    if cleaned == "" then return "root" end
    return "query:" .. cleaned
end

return Nav
