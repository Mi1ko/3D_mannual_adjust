# Manual Adjust App

这个工具用于对已经规则生成好的 3D 标签布局做人工微调。下面所有路径都以本 app 目录为根目录。
## 常见问题

### 注意事项
1. 看正视角obj模型，有没有连接线穿模，如果有，调整。这里调整锚点位置一般都更为有效；
2. 看正视角，有没有引导线交叉，如果有调整；
3. 把正视角调整好之后，看其它视角有没有明显交叉情况，如果有，调整。一般情况下先尝试调整锚点会方便一点，这里要注意不要影响正视角；
4. 消除交叉情况之后，再看有没有连接线在物体上的情况
5. 检查obj和各个视角的obj
6. 觉得差不多可以了就可以保存，然后再继续调一调试试，看能不能更好，当一个备份


### 加载样本为什么应该很快？

加载现在只读取 input 中已有的 JSON、Mutiviews 和 Obj-O，不会重新渲染。真正耗时的是“生成投影”，因为它需要重新合并 OBJ-O 并用 pyrender 渲染五个视角。

### 什么时候需要点“生成投影”？

当你移动了标签或锚点，并希望检查当前布局在五视角下的真实 OBJ-O 渲染效果时，点击“生成投影”，耗时较长，需要酌情选择是否生成投影。

### 什么时候需要点“保存完整结果”？

当你确认当前布局可以作为人工微调结果时，填写名字并点击“保存完整结果”。这会把 annotation、五视角投影和五个朝向的 OBJ-O 写入 `data/output/Layout/<category>/<sample_id>/layout1`。


### 目录结构

建议直接将整个数据集切片放到input下然后把test删掉，在开始干活之前把output清空，然后在没有完成所有的之前都存到output里面，因为系统可以定位到最近未被微调的样本。

## 安装依赖

建议使用 Python 3.10 或更高版本。

```powershell
python -m pip install numpy pillow trimesh pyrender PyOpenGL pyglet
```

依赖用途：

- `numpy`：坐标变换、相机坐标系和投影计算。
- `pillow`：读取和保存投影图、拼接五视角图。
- `trimesh`：读取 OBJ/MTL。
- `pyrender`、`PyOpenGL`、`pyglet`：离屏渲染 OBJ-O 投影图。

网页中的 OBJ-O 三维预览使用浏览器端 Three.js CDN：

```html
https://unpkg.com/three@0.164.1/
```

如果机器不能访问外网，后端生成投影和保存功能仍然可用，但网页里的三维 OBJ-O 预览可能无法加载。

## 启动和停止

进入 app 目录后启动：

```powershell
python web_projection_editor.py
```

默认地址：

```text
http://127.0.0.1:8780
```

如果是在当前终端启动，按 `Ctrl+C` 停止。  
如果是后台启动，可以用：

```powershell
$pid = Get-Content data\temp\manual_app.pid
Stop-Process -Id $pid -Force
```

## 默认目录

```text
data/
├── input/    # 输入数据，只读
├── output/   # 人工微调后的正式输出
└── temp/     # 生成投影时的临时文件
```

网页默认输入目录是：

```text
data/input
```

网页默认输出目录是：

```text
data/output
```

加载样本时不会修改 `data/input` 下的任何文件。

## 输入数据结构

当前输入结构必须遵循 3DLPD 的类别层级。输入目录可以是一个完整数据集根目录，也可以是包含多个数据集切片的上一级目录；程序只扫描 `layout2`。

```text
data/input/
└── <dataset_or_split>/
    ├── Meta.json
    ├── Obj-P/
    │   └── <category>/<sample_id>/<sample_id>-P.obj
    ├── Points/
    │   └── <category>/<sample_id>/
    ├── Text_objs/
    │   └── <category>/<sample_id>/
    └── Layout/
        └── <category>/
            └── <sample_id>/
              └── layout2/
                ├── Annotation/<sample_id>.json
                ├── Rating/
                ├── Mutiviews/<sample_id>-main.png
                ├── Mutiviews/<sample_id>-up.png
                ├── Mutiviews/<sample_id>-down.png
                ├── Mutiviews/<sample_id>-left.png
                ├── Mutiviews/<sample_id>-right.png
                ├── Mutiviews/<sample_id>-combined.png
                └── Obj-O/
                    ├── <sample_id>-O.mtl
                    ├── <sample_id>-main-O.obj
                    ├── <sample_id>-up-O.obj
                    ├── <sample_id>-down-O.obj
                    ├── <sample_id>-left-O.obj
                    └── <sample_id>-right-O.obj
```

其中：

- `Layout/<category>/<sample_id>/layout2` 表示规则生成结果。
- `Annotation` 是微调时读取的布局 JSON。
- `Mutiviews` 是加载样本时直接显示的已有投影图。
- `Obj-O` 是输入状态下的三维预览来源。
- `Text_objs` 用于点击“生成投影”或“保存完整结果”时重新合并 OBJ-O；缺失时无法生成或保存。
- `Points` 当前网页不直接使用，但建议保留在数据集中。

程序不再兼容旧数字 layout 目录或无类别层目录；旧的 `1`、`2`、`3`、`ANNOTATION`、`OBJ-P`、`TEXT_OBJS` 结构不会被扫描。

## 加载样本

打开网页后，程序会扫描输入目录，并自动加载第一个还没有完整人工微调输出的样本。

加载样本时只做这些事情：

- 读取 input 中的 annotation JSON。
- 在内存中套用 app 内部固定相机参数。
- 读取 input 中已有的 `Mutiviews` 用于五视角显示。
- 读取 input 中已有的 `Obj-O` 用于 OBJ-O 预览。

加载阶段不会重新渲染投影，也不会生成临时 OBJ-O，因此速度应该主要取决于读取文件和加载网页资源。

## 相机参数

相机参数由 app 内部代码固定，防止输入 JSON 或 Meta.json 里的错误相机污染结果。

默认参数在 `settings.py` 中维护，当前包括：

- 相机半径：`10`
- 焦距：`50 mm`
- 传感器：`36 mm x 24 mm`
- 投影图尺寸：`750 x 500`
- 标签朝向：`adaptive`

保存到输出 JSON 时不会写入 `camera`、`settings`、`projection_images` 等与布局无关的运行字段。

## 微调方式

页面一次只编辑一个对象，可以选择：

- `标签`：移动 `label.center`。
- `锚点`：移动 `anchor.point`。

移动使用主视角观察坐标系：

- `+x / -x`
- `+y / -y`
- `+z / -z`

可以用按钮、滑条或坐标输入框移动。移动后只记录在页面内存中，不会立即写 JSON，也不会自动生成投影。

五视角图上会显示：

- 当前选中对象的瞄准靶。
- 标签对象的当前 2D 投影框。
- 已经移动过的对象的绿色“起点/终点”标记。

点击“生成投影”成功后，当前状态会成为新的基准点，绿色起点/终点标记会清空。之后继续移动时会重新出现。

## OBJ-O 预览状态

OBJ-O 预览器有三个状态：

- `输入状态`：读取 input 中的 `Layout/<category>/<sample_id>/layout2/Obj-O`。
- `输出状态`：读取 output 中的 `Layout/<category>/<sample_id>/layout1/Obj-O`；如果没有输出则显示为空。
- `微调中`：读取 `data/temp/preview_obj_o/<sample_id>`。

点击“生成投影”后会生成新的微调中 OBJ-O，并自动切到 `微调中`。

如果当前坐标已经变化，但还没有重新点击“生成投影”，`微调中` 仍然显示上一次生成的临时 OBJ-O；这时选择框左侧会提示“已变化请更新”。

视角可以选择：

- 主视角
- 上视角
- 下视角
- 左视角
- 右视角

## 生成投影

点击“生成投影”会基于当前页面内存中的坐标实时生成预览结果，但不会写正式输出 JSON。

流程是：

1. 用当前 annotation、`Obj-P` 和 `Text_objs` 合并 OBJ-O。
2. 因为标签朝向是 `adaptive`，所以每个视角生成一个 OBJ-O：

```text
data/temp/preview_obj_o/<sample_id>/
├── <sample_id>-O.mtl
├── <sample_id>-main-O.obj
├── <sample_id>-up-O.obj
├── <sample_id>-down-O.obj
├── <sample_id>-left-O.obj
└── <sample_id>-right-O.obj
```

3. 使用这些 OBJ-O 通过 pyrender 渲染五视角图片：

```text
data/temp/preview_projection/<category>/<sample_id>/
├── <sample_id>-main.png
├── <sample_id>-up.png
├── <sample_id>-down.png
├── <sample_id>-left.png
├── <sample_id>-right.png
└── <sample_id>-combined.png
```

生成投影不会修改 input，也不会修改 output。

## 保存完整结果

保存前必须填写名字。点击“保存完整结果”后，结果写入输出目录：

```text
data/output/
└── Layout/
    └── <category>/
        └── <sample_id>/
            └── layout1/
                ├── Annotation/<sample_id>.json
                ├── Rating/
                ├── Mutiviews/<sample_id>-main.png
                ├── Mutiviews/<sample_id>-up.png
                ├── Mutiviews/<sample_id>-down.png
                ├── Mutiviews/<sample_id>-left.png
                ├── Mutiviews/<sample_id>-right.png
                ├── Mutiviews/<sample_id>-combined.png
                └── Obj-O/
                    ├── <sample_id>-O.mtl
                    ├── <sample_id>-main-O.obj
                    ├── <sample_id>-up-O.obj
                    ├── <sample_id>-down-O.obj
                    ├── <sample_id>-left-O.obj
                    └── <sample_id>-right-O.obj
```

其中 `Layout/<category>/<sample_id>/layout1` 表示人工微调后的优秀布局，可作为 ground truth。

保存后的 JSON 会：

- 将 `version` 写为 `after_mannual_adjust`。
- 在 `version` 下一行写入 `name`。
- 将 `layout_level` 写为 `layout1`。
- 将 `layout_type` 写为 `manual_adjusted`。
- 保留布局相关字段，如 `sample_id`、`category`、`normalization`、`groups`。
- 删除运行和生成相关字段，如 `camera`、`settings`、`projection_images`、`layout_goal`、`sample_root`、`bad_generation`、`model_cat`。

如果 output 中已经存在该样本的完整人工微调结果，页面顶部样本标题会出现黄色高亮，提醒你确认是否要重新微调。

## 不会修改 input 的操作

以下操作都不会修改 input：

- 加载样本。
- 切换标签或锚点。
- 移动标签或锚点。
- 点击“生成投影”。
- 切换 OBJ-O 预览状态或视角。

只有点击“保存完整结果”才会写入 `data/output`。

## 临时目录

`data/temp` 只存放运行时文件，可以按需清理：

```text
data/temp/
├── preview_obj_o/          # 生成投影时的临时 OBJ-O
├── preview_projection/     # 生成投影时的临时五视角图片
├── part_overlays/          # 旧版/调试用部件覆盖图缓存
├── manual_app.pid          # 后台进程 PID
├── manual_app.stdout.log   # 后台日志
└── manual_app.stderr.log   # 后台错误日志
```

清理 `preview_obj_o` 和 `preview_projection` 不会影响 input 或 output；之后点击“生成投影”会重新生成。


