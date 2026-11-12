--- Everything the player can pick up and use, what the tasks ask for, and
-- the collection book. Data only.

local world = require "island.world"

local M = {}

-- Object ids are written into saved islands: never renumber them.
M.HOUSE, M.SHOP, M.PAVILION, M.TOWER, M.WINDMILL, M.LIGHTHOUSE = 1, 2, 3, 4, 5, 6
M.TREE, M.PINE, M.SAKURA, M.MAPLE, M.PALM, M.BUSH = 10, 11, 12, 13, 14, 15
M.BENCH, M.LAMP, M.FENCE, M.ROCK, M.WELL, M.MAILBOX = 20, 21, 22, 23, 24, 25
M.FLAG, M.CAMPFIRE, M.SCARECROW, M.HAYSTACK, M.SNOWMAN = 26, 27, 28, 29, 30

--- What a tool does when the finger moves over the island.
--   sculpt  moves the ground (mode)            paint  changes ground cover (surface)
--   dig     carves water (radius scale)        place  puts an object down (item)
--   road    draws road                         erase  removes objects and roads
-- Looking around is not a tool: it is a mode of its own (app.hand).
M.tools = {
    { key = "raise", name = "抬高", type = "sculpt", mode = "raise", group = "terrain", start = true },
    { key = "lower", name = "压低", type = "sculpt", mode = "lower", group = "terrain", start = true },
    { key = "flatten", name = "抹平", type = "sculpt", mode = "flatten", group = "terrain", start = true },
    { key = "smooth", name = "圆滑", type = "sculpt", mode = "smooth", group = "terrain", start = true },

    { key = "grass", name = "草地", type = "paint", surface = world.GRASS, group = "ground", start = true, swatch = { 0.47, 0.74, 0.36 } },
    { key = "sand", name = "沙地", type = "paint", surface = world.SAND, group = "ground", start = true, swatch = { 0.93, 0.85, 0.62 } },
    { key = "flowers", name = "花田", type = "paint", surface = world.FLOWERS, group = "ground", swatch = { 0.98, 0.62, 0.72 } },
    { key = "wheat", name = "麦田", type = "paint", surface = world.WHEAT, group = "ground", swatch = { 0.93, 0.78, 0.33 } },
    { key = "lavender", name = "薰衣草", type = "paint", surface = world.LAVENDER, group = "ground", swatch = { 0.66, 0.52, 0.86 } },
    { key = "paving", name = "石板地", type = "paint", surface = world.PAVING, group = "ground", swatch = { 0.78, 0.76, 0.72 } },
    { key = "snow", name = "雪地", type = "paint", surface = world.SNOW, group = "ground", swatch = { 0.96, 0.97, 1.0 } },

    { key = "river", name = "小河", type = "dig", scale = 0.55, group = "water", swatch = { 0.35, 0.72, 0.88 } },
    { key = "lake", name = "湖泊", type = "dig", scale = 1.3, group = "water", swatch = { 0.22, 0.58, 0.82 } },

    { key = "house", name = "小屋", type = "place", item = M.HOUSE, group = "build", building = true, swatch = { 0.96, 0.78, 0.6 } },
    { key = "shop", name = "小店", type = "place", item = M.SHOP, group = "build", building = true, swatch = { 0.95, 0.55, 0.5 } },
    { key = "pavilion", name = "凉亭", type = "place", item = M.PAVILION, group = "build", building = true, swatch = { 0.75, 0.42, 0.32 } },
    { key = "tower", name = "钟楼", type = "place", item = M.TOWER, group = "build", building = true, swatch = { 0.86, 0.84, 0.78 } },
    { key = "windmill", name = "风车", type = "place", item = M.WINDMILL, group = "build", building = true, swatch = { 0.92, 0.9, 0.84 } },
    { key = "lighthouse", name = "灯塔", type = "place", item = M.LIGHTHOUSE, group = "build", building = true, swatch = { 0.92, 0.32, 0.3 } },

    { key = "tree", name = "圆树", type = "place", item = M.TREE, group = "plant", tree = true, swatch = { 0.36, 0.66, 0.34 } },
    { key = "pine", name = "松树", type = "place", item = M.PINE, group = "plant", tree = true, swatch = { 0.2, 0.46, 0.34 } },
    { key = "bush", name = "灌木", type = "place", item = M.BUSH, group = "plant", swatch = { 0.42, 0.7, 0.38 } },
    { key = "sakura", name = "樱花树", type = "place", item = M.SAKURA, group = "plant", tree = true, swatch = { 0.98, 0.72, 0.8 } },
    { key = "palm", name = "椰子树", type = "place", item = M.PALM, group = "plant", tree = true, swatch = { 0.4, 0.74, 0.42 } },
    { key = "maple", name = "枫树", type = "place", item = M.MAPLE, group = "plant", tree = true, swatch = { 0.9, 0.42, 0.24 } },

    { key = "bench", name = "长椅", type = "place", item = M.BENCH, group = "decor", swatch = { 0.66, 0.46, 0.3 } },
    { key = "rock", name = "石头", type = "place", item = M.ROCK, group = "decor", swatch = { 0.62, 0.63, 0.66 } },
    { key = "lamp", name = "路灯", type = "place", item = M.LAMP, group = "decor", swatch = { 1.0, 0.86, 0.45 } },
    { key = "fence", name = "篱笆", type = "place", item = M.FENCE, group = "decor", swatch = { 0.86, 0.74, 0.56 } },
    { key = "well", name = "水井", type = "place", item = M.WELL, group = "decor", swatch = { 0.6, 0.62, 0.66 } },
    { key = "mailbox", name = "邮筒", type = "place", item = M.MAILBOX, group = "decor", swatch = { 0.88, 0.3, 0.28 } },
    { key = "flag", name = "旗杆", type = "place", item = M.FLAG, group = "decor", swatch = { 0.95, 0.5, 0.3 } },
    { key = "campfire", name = "篝火", type = "place", item = M.CAMPFIRE, group = "decor", swatch = { 1.0, 0.6, 0.2 } },
    { key = "scarecrow", name = "稻草人", type = "place", item = M.SCARECROW, group = "decor", swatch = { 0.85, 0.7, 0.4 } },
    { key = "haystack", name = "草垛", type = "place", item = M.HAYSTACK, group = "decor", swatch = { 0.92, 0.8, 0.42 } },
    { key = "snowman", name = "雪人", type = "place", item = M.SNOWMAN, group = "decor", swatch = { 0.97, 0.98, 1.0 } },

    { key = "road", name = "小路", type = "road", group = "road", swatch = { 0.84, 0.78, 0.68 } },
    { key = "erase", name = "橡皮", type = "erase", group = "road", start = true, swatch = { 0.95, 0.6, 0.6 } },
}

M.groups = {
    { key = "terrain", name = "地形" },
    { key = "ground", name = "地表" },
    { key = "water", name = "水" },
    { key = "build", name = "房子" },
    { key = "plant", name = "植物" },
    { key = "decor", name = "装饰" },
    { key = "road", name = "路" },
}

M.tool_by_key, M.tool_by_item = {}, {}
for index, tool in ipairs(M.tools) do
    tool.index = index
    M.tool_by_key[tool.key] = tool
    if tool.item then M.tool_by_item[tool.item] = tool end
end

function M.is_building(item)
    local tool = M.tool_by_item[item]
    return tool ~= nil and tool.building == true
end

function M.is_tree(item)
    local tool = M.tool_by_item[item]
    return tool ~= nil and tool.tree == true
end

--- Brush sizes (radius in cells) and strengths the player can choose.
M.RADII = { 1.2, 2.0, 3.0, 4.2, 5.8 }
M.STRENGTHS = { 0.35, 0.7, 1.4 }
M.COUNTS = { 1, 3, 6 }

--- Tasks, in the order they are given. `value(p)` reads the progress table
-- the game keeps: p.stats (world.stats), p.count.<name>, p.flag.<name>.
M.tasks = {
    { title = "捏出一块陆地", hint = "选「抬高」，在海面上按住画一画", goal = 60,
      value = function(p) return p.stats.land end, reward = { "flowers", "wheat" } },
    { title = "给小岛换件衣裳", hint = "到「地表」里选一种，涂 15 格", goal = 15,
      value = function(p) return p.count.painted end, reward = { "river", "lake" } },
    { title = "挖一条小河", hint = "到「水」里选小河，在岛上画一道", goal = 6,
      value = function(p) return p.count.dug end, reward = { "house", "tree" } },
    { title = "盖第一座小屋", hint = "到「房子」里选小屋，点一下空地", goal = 1,
      value = function(p) return p.stats.by_item[M.HOUSE] or 0 end, reward = { "road", "bench" } },
    { title = "种下 5 棵树", hint = "到「植物」里选一棵，点几下", goal = 5,
      value = function(p) return p.trees end, reward = { "pine", "bush", "rock" } },
    { title = "画一条小路", hint = "选「小路」，从屋门口往外画 8 格", goal = 8,
      value = function(p) return p.stats.roads end, reward = { "lamp", "fence", "shop" } },
    { title = "迎来 3 位岛民", hint = "房子挨着路，就会有人搬进来", goal = 3,
      value = function(p) return p.population end, reward = { "sakura", "well", "mailbox" } },
    { title = "让房子连成一排", hint = "把 3 座小屋挨着放，屋顶会自己连起来", goal = 3,
      value = function(p) return p.longest_row end, reward = { "pavilion", "lavender" } },
    { title = "在水边安个家", hint = "把小屋放在水边，会自己长出码头", goal = 1,
      value = function(p) return p.docks end, reward = { "palm", "flag" } },
    { title = "修一座小桥", hint = "让小路画过水面，就会搭起木桥", goal = 1,
      value = function(p) return p.stats.bridges end, reward = { "tower", "paving" } },
    { title = "看一次日落", hint = "点「天色」，把时间拖到傍晚", goal = 1,
      value = function(p) return p.flag.sunset and 1 or 0 end, reward = { "campfire", "maple" } },
    { title = "走过四季", hint = "在「天色」里把春夏秋冬都看一遍", goal = 4,
      value = function(p) return p.count.seasons end, reward = { "snow", "snowman", "scarecrow", "haystack" } },
    { title = "等一场彩虹", hint = "先下一场雨，再放晴", goal = 1,
      value = function(p) return p.flag.rainbow and 1 or 0 end, reward = { "windmill" } },
    { title = "拍一张照片", hint = "点「拍照」，挑个滤镜按下快门", goal = 1,
      value = function(p) return p.flag.photo and 1 or 0 end, reward = { "lighthouse" } },
    { title = "请朋友来逛逛", hint = "在「分享」里复制岛屿码，发给朋友", goal = 1,
      value = function(p) return p.flag.shared and 1 or 0 end, reward = {} },
}

--- The collection book: 57 things to come across. Tools and objects are
-- found by using them, the rest by seeing it happen on the island.
M.collection = {}
local function entry(key, name, group)
    M.collection[#M.collection + 1] = { key = key, name = name, group = group }
end
for _, tool in ipairs(M.tools) do
    if tool.type == "paint" or tool.type == "dig" or tool.type == "place" or tool.type == "road" then
        entry(tool.key, tool.name, tool.group)
    end
end
entry("row", "联排屋", "auto") entry("chimney", "烟囱", "auto") entry("dock", "小码头", "auto")
entry("junction", "路口", "auto") entry("bridge", "木桥", "auto") entry("beach", "沙滩", "auto")
entry("reef", "礁石", "auto") entry("foam", "浪花", "auto") entry("streetlamp", "路边的灯", "auto")
entry("walker", "散步的岛民", "life") entry("fisher", "钓鱼的岛民", "life") entry("dreamer", "发呆的岛民", "life")
entry("boat", "小船", "life") entry("gull", "海鸥", "life") entry("smoke", "炊烟", "life")
entry("firefly", "萤火虫", "life") entry("window", "亮灯的窗", "life")
entry("bloom", "樱花季", "sky") entry("redleaf", "红叶季", "sky") entry("snowcover", "积雪", "sky")
entry("rain", "雨天", "sky") entry("fog", "雾天", "sky") entry("snowfall", "雪天", "sky") entry("rainbow", "彩虹", "sky")

M.collection_groups = {
    { key = "ground", name = "地表" }, { key = "water", name = "水" }, { key = "build", name = "房子" },
    { key = "plant", name = "植物" }, { key = "decor", name = "装饰" }, { key = "road", name = "路" },
    { key = "auto", name = "自己长出来的" }, { key = "life", name = "岛上的生活" }, { key = "sky", name = "天色" },
}

--- What an islander says when tapped. Picked by what they are doing and by the sky.
M.lines = {
    walk = { "今天的风真舒服。", "我去那边转转。", "这条路是新修的吧？", "走走路，消消食。", "岛上又热闹了一点。" },
    fish = { "嘘——鱼要上钩了。", "今天钓到三条！", "这片水真清。", "再等一会儿就有了。" },
    idle = { "我在发呆，别吵我。", "云一朵一朵飘过去了。", "坐一会儿再走。", "这里看海正好。" },
    night = { "灯亮了，该回家啦。", "你看，萤火虫！", "晚上的海有点好听。" },
    rain = { "下雨啦，快躲躲！", "雨后说不定有彩虹。" },
    snow = { "下雪了！要不要堆雪人？", "好冷，想喝热汤。" },
    spring = { "樱花开了，真好看。" },
    autumn = { "叶子都红了。" },
}

M.SEASONS = { "春", "夏", "秋", "冬" }
M.WEATHERS = { { key = "sunny", name = "晴" }, { key = "rain", name = "雨" }, { key = "fog", name = "雾" },
               { key = "snow", name = "雪" }, { key = "rainbow", name = "彩虹" } }

--- Photo filters: tint and saturation, applied by every material.
M.filters = {
    { name = "原色", grade = { 1, 1, 1, 1 } },
    { name = "暖阳", grade = { 1.08, 1.0, 0.88, 1.1 } },
    { name = "清晨", grade = { 0.92, 1.0, 1.1, 0.95 } },
    { name = "胶片", grade = { 1.05, 0.98, 0.9, 0.7 } },
    { name = "黑白", grade = { 1, 1, 1, 0 } },
    { name = "糖果", grade = { 1.05, 1.02, 1.08, 1.45 } },
}
M.frames = { "无框", "白边", "拍立得", "电影" }

--- Island level from what has been built.
function M.level(stats, population)
    local score = stats.land * 0.25 + stats.objects * 3 + stats.roads * 1 + population * 6
    local level = 1
    local need = 30
    while score >= need and level < 30 do
        score = score - need
        level = level + 1
        need = need + 25
    end
    return level, score / need
end

return M
