# Manual Adjust App

这个工具用于对已经规则生成好的 3D 标签布局做人工微调。下面所有路径都以本 app 目录为根目录。

## 版本更新日志

### v0.3

本版本重点补齐了微调端自检、生成结果自检和 Obj-O 生成一致性：微调端在首次进入页面、刷新文件列表、保存或导入审核文件后会后台检查 input 样本是否满足微调所需资源，问题样本会在下拉框标记“有问题”，顶部状态栏会显示具体原因；该自检只覆盖微调阶段真正依赖的 Annotation、Obj-P、Text_objs/TEXT_OBJS、Mutiviews 和 Obj-O，不再把 Points 作为 input 必需项。导入审核文件时会校验审核记录字段，保存完整结果后会回读检查 output Annotation、Mutiviews、Obj-O、MTL 和 `manual_adjust_records.json`。Obj-O 生成逻辑同步为标签和连接线同时写入 `o label_xxx`/`g label_xxx`、`o leader_xxx`/`g leader_xxx`，生成后的 output/admin/最终整体检查会拦截缺失 `g` 分组的 Obj-O；旧 input Obj-O 保持兼容，不作为微调端错误。连接线仍在三维中连接锚点和标签中心方向，但生成 Obj-O 时会裁到标签包围盒外表面，五视角投影统一基于生成后的 Obj-O 通过 trimesh/pyrender 渲染。

本版本还增加了排查和审核合并保护：后端会以追加模式写入项目根目录 `manual_adjust_app.log`，前端在“只读相机”下方实时显示最新日志；“数据”标题栏新增 `需修改 x/y`，统计待微调和已审核待修改样本占总样本数的比例。导入审核文件时，合并前的本地 `manual_adjust_records.json` 和导入的审核文件会分别归档到 `data/review_history/<时间戳>/`，最终合并结果仍写入当前输出目录的 `manual_adjust_records.json`。为避免旧状态或误选 JSON 导致 `input_annotation_path` 错写，加载 input Annotation 时会强制要求路径来自 `layout2`，且路径中的类别/样本号必须和 JSON 内容一致；保存记录前也会再次校验 `input_annotation_path`，从 output 继续微调时只读取 output 的 layout1 内容，记录中的 input 路径仍保持为对应的 input/layout2。

审核端新增“原始视图”按钮，可在同一个审核样本内切换查看微调者提交的 layout1 结果和原始 layout2 结果。审核样本来源仍然只来自 `data/admin/pending` 和 `data/admin/review_results`；新增的 `ADMIN_INPUT_ROOT` 只用于配置分配任务根目录，例如 `C:\Users\bacho\Desktop\AMIL\3D_Datasets\task`，程序会按当前样本匹配原始 `Layout/<category>/<sample_id>/layout2`，并显示其中的 Obj-O 和五视角投影图。若找不到对应原始样本，原始视图按钮会禁用并提示原因。

### v0.2

本版本完善了微调与审核的完整闭环：微调端新增从 `input` / `output` 显式加载、撤销/重做、状态筛选、自评筛选、自评与备注、导入审核文件、本地导出 zip （以后提交的结果均为导出的zip）等功能；审核端新增 `pending` 待审核目录和 `review_results` 审核结果目录，审核结果会实时保存，支持审核模式/查看模式、样本直达、状态提示和审核记录导出。界面方面重做了 3x2 预览布局，可同时查看 OBJ-O 和五个投影视角，并增加放大查看、紧凑路径显示和更清晰的顶部表单。蓝色标签瞄准靶、红色锚点瞄准靶、绿色位移起止点已统一为和投影图一致的等比例缩放逻辑，并在多种分辨率下验证对齐。记录文件升级为 `schema_version: 2`，只保存机器可读字段，不再把中文显示 label 写入 JSON，同时兼容旧版记录和旧审核文件导入。

### v0.1

修正导出文件不支持中文的问题，导出的 zip 和审核记录文件现在可以正常处理中文姓名、中文路径和中文备注。

## 获取和更新代码


```powershell
git clone https://github.com/Mi1ko/3D_mannual_adjust.git
cd 3D_mannual_adjust
```

已有本地仓库时，拉取最新代码：

```powershell
git pull origin main
```

`data/` 目录已被 Git 忽略，不会随代码仓库上传或下载。每个人需要在自己的本地仓库中准备数据目录，也就是替换 data 目录。


如果需要使用 admin 页面的 3DLPD 参考数据自动校验（审核人员需要，微调人员不需要），复制本地配置模板并填写自己机器上的数据集路径：

```powershell
Copy-Item local_config.example.py local_config.py
```

然后编辑 `local_config.py`：

```python
REFERENCE_DATASET_ROOT = Path(r"D:\path\to\3DLPD")
```

`local_config.py` 包含本机路径等固定配置，已被 Git 忽略，不会上传。没有配置时，程序默认查找 `data/reference_3dlpd`，不存在则 admin 校验面板会提示参考目录缺失，但不影响普通微调和审核保存。


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

当你确认当前布局可以作为人工微调结果时，填写名字、选择自评并点击“保存完整结果”。这会把 annotation、五视角投影、五个朝向的 OBJ-O 和微调记录写入 `data/output`。


### 目录结构

建议直接将整个数据集切片放到 `data/input` 下。在开始新一批任务之前可以清空 `data/output`，本轮所有微调结果都保存到 `data/output`。审核人员收到微调者导出的 zip 后，解压到 `data/admin/pending/<提交包名>` 下审核。

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
如果是后台启动，可以按端口找到进程并停止：

```powershell
$pid = Get-NetTCPConnection -LocalPort 8780 -State Listen | Select-Object -First 1 -ExpandProperty OwningProcess
Stop-Process -Id $pid
```

## 默认目录

```text
data/
├── input/    # 输入数据，只读
├── output/   # 人工微调后的正式输出
├── admin/    # 审核人员解压微调者提交 zip 的目录
├── export/   # 本地导出目录，导出的 zip 和审核记录会写到这里
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

`data/output/manual_adjust_records.json` 是微调记录文件，不属于原始数据集结构，但会随导出 zip 一起给审核人员使用。审核人员导出的审核记录也会写到 `data/export`。

## 输入数据结构

当前输入结构必须遵循 3DLPD 的类别层级。输入目录可以是一个完整数据集根目录，也可以是包含多个数据集切片的上一级目录；程序只扫描 `layout2`。

```text
data/input/
└── <dataset_or_split>/
    ├── Meta.json
    ├── Obj-P/
    │   └── <category>/<sample_id>/<sample_id>-P.obj
    ├── Text_objs/ 或 TEXT_OBJS/
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
- `Text_objs` 或 `TEXT_OBJS` 用于点击“生成投影”或“保存完整结果”时重新合并 OBJ-O；缺失时无法生成或保存。
- `Points` 不属于微调端 input 必需目录，微调端自检不会检查 Points；Points 只在 admin/最终整体检查或数据集检查脚本中使用。

程序不再兼容旧数字 layout 目录或无类别层目录；旧的 `1`、`2`、`3`、`ANNOTATION`、`OBJ-P` 结构不会被扫描。当前类别层级下的 `Text_objs` 和 `TEXT_OBJS` 均可识别。

## 加载样本

打开网页后，程序会扫描输入目录，并自动加载第一个样本。样本下拉框会显示当前状态，可用“状态筛选”只看某一类样本；切换状态筛选后会自动加载筛选后的第一个样本。

加载样本时只做这些事情：

- 读取 input 中的 annotation JSON。
- 在内存中套用 app 内部固定相机参数。
- 读取 input 中已有的 `Mutiviews` 用于五视角显示。
- 读取 input 中已有的 `Obj-O` 用于 OBJ-O 预览。

加载阶段不会重新渲染投影，也不会生成临时 OBJ-O，因此速度应该主要取决于读取文件和加载网页资源。

页面提供两个加载入口：

- `从 input 加载`：从 `data/input` 的 layout2 结果开始微调。
- `从 output 加载`：从 `data/output` 已保存的 layout1 微调结果继续微调，适合二次调整或审核后返修。

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

页面支持“上一步/下一步”撤销和重做。撤销历史只保存在当前样本的页面内存里，切换样本或刷新网页后会重置。

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

保存前必须填写名字并选择自评。自评分为：

- `好`
- `中`
- `差`

备注可选，用来说明本次微调的疑点或希望审核重点关注的地方。点击“保存完整结果”后，结果写入输出目录：

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

保存还会更新：

```text
data/output/manual_adjust_records.json
```

该文件记录微调者姓名、自评、备注、审核结果、状态和历史时间线。它不是数据集本身的一部分，但会随导出 zip 一起交给审核人员。

## 状态和记录文件

样本状态统一记录在 `manual_adjust_records.json` 中：

- `待微调`：还没有微调记录。
- `已微调待审核`：微调人员保存过结果，等待审核；复审中的再次提交也会归到这一类。
- `已审核待修改`：审核评价为 `中` 或 `差`，需要微调人员返修。
- `已审核为优`：审核评价为 `优`，该样本无需继续修改。

记录文件当前使用 `schema_version: 2`。JSON 里只保存机器可读字段，例如 `event`、`rating`、`status`、`remark`、`at`，不会保存 `已审核为优`、`优` 这类展示文案；页面显示的中文状态和评价由代码根据 `event`、`rating` 和 `status` 推断。旧版记录文件中的 `rating_label` 或历史 `label` 字段会在读取、导入、导出审核文件时自动兼容转换。

审核文件导入时只覆盖重复样本的审核相关字段，不会整体覆盖本地记录文件。这样微调人员在审核文件导出后继续工作的进度不会被整份旧审核文件抹掉。

如果 output 中有旧版微调结果，但没有 `manual_adjust_records.json`，点击“导出全部 ZIP”时会自动初始化记录文件：扫描 `data/output/Layout/*/*/layout1/Annotation/*.json`，把这些样本记录为 `已微调待审核`，微调者姓名使用页面里填写的名字，自评统一为 `未知`。

## 导出与提交

微调页面点击“导出全部 ZIP”后，不会触发浏览器下载。程序会把 zip 写入本地目录：

```text
data/export/<名字>_<YYYYMMDD>.zip
```

导出成功后页面会弹窗显示完整路径。zip 内容来自 `data/output`，不会包含旧版 preview 文件夹；`manual_adjust_records.json` 会一并导出。

如果同名文件已存在，程序会自动追加 `_2`、`_3`，避免覆盖已有导出。

## 审核流程

审核页面地址：

```text
http://127.0.0.1:8780/admin
```

审核人员收到微调者的 zip 后，先解压到：

```text
data/admin/pending/<提交包名>/
```

解压后的目录应直接包含 `manual_adjust_records.json` 和 `Layout/`。admin 页面会扫描 `data/admin/pending` 下所有带记录文件的提交包，审核结果实时写入 `data/admin/review_results/<提交包名>/manual_adjust_records.json`。

admin 页面会显示：

- 微调者姓名。
- 微调者自评和备注。
- 当前状态和已审查数量。
- OBJ-O 预览和五个视角投影。
- 审核评价、审核备注和历史记录。

审核评价分为 `优`、`中`、`差`。保存审核后：

- `优`：状态变为 `已审核为优`。
- `中` 或 `差`：状态变为 `已审核待修改`。

admin 页面点击“导出审核文件”后，也不会触发浏览器下载，而是写入：

```text
data/export/<提交包名>_review_records_<YYYYMMDD>.json
```

微调人员拿到这个审核记录 JSON 后，在微调页面点击“导入审核文件”。导入后页面会显示审核评价、审核状态和审核备注，并可通过状态筛选快速找到需要修改的样本。

## 不会修改 input 的操作

以下操作都不会修改 input：

- 加载样本。
- 按状态筛选样本。
- 从 input 或 output 加载样本。
- 切换标签或锚点。
- 移动标签或锚点。
- 点击“生成投影”。
- 切换 OBJ-O 预览状态或视角。
- 导入审核文件。导入审核文件只修改 `data/output/manual_adjust_records.json`。

点击“保存完整结果”会写入 `data/output/Layout/.../layout1` 并更新 `data/output/manual_adjust_records.json`。点击“导出全部 ZIP”会写入 `data/export`。

## 临时目录

`data/temp` 只存放运行时文件，可以按需清理：

```text
data/temp/
├── preview_obj_o/          # 生成投影时的临时 OBJ-O
├── preview_projection/     # 生成投影时的临时五视角图片
└── part_overlays/          # 旧版/调试用部件覆盖图缓存
```

清理 `preview_obj_o` 和 `preview_projection` 不会影响 input 或 output；之后点击“生成投影”会重新生成。
