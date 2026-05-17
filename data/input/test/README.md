# 3DLPD Dataset

3DLPD 是一个面向 3D 零件标注布局的多视角数据集。每个样本包含归一化后的 3D 物体、零件点云、零件文本模型、布局标注 JSON、多视角渲染图，以及用于投影和渲染的全局相机参数。

本文档按完整数据集结构描述，`<DATASET_ROOT>` 表示 3DLPD 数据集根目录。

## Directory Structure

```text
<DATASET_ROOT>/
  Meta.json
  Layout/
    <Category>/
      <SampleID>/
        <LayoutName>/
          Annotation/
            <SampleID>.json
          Mutiviews/
            <SampleID>-main.png
            <SampleID>-up.png
            <SampleID>-down.png
            <SampleID>-left.png
            <SampleID>-right.png
            <SampleID>-combined.png
          Obj-O/
            <SampleID>-O.mtl
            <SampleID>-main-O.obj
            <SampleID>-up-O.obj
            <SampleID>-down-O.obj
            <SampleID>-left-O.obj
            <SampleID>-right-O.obj
          Rating/
  Obj-P/
    <Category>/
      <SampleID>/
        <SampleID>-P.obj
  Points/
    <Category>/
      <SampleID>/
        *.pts
        *.ply
        *.txt
  Text_objs/
    <Category>/
      <SampleID>/
        <label_text>.obj
        summary.json
```

路径中的 `<Category>` 是类别名，例如 `Chair`、`Faucet`、`Lamp` 等；`<SampleID>` 是样本编号。类别文件夹位于样本编号的上一级，样本编号本身应保持稳定，不建议重命名。

注意：目录名 `Mutiviews` 沿用当前数据中的拼写。

## Main Components

`Meta.json`  
记录数据集级别的元信息，包括 layout level 的含义、默认相机参数和投影图像参数。所有样本共用这套相机配置，除非单个样本显式覆盖。

`Layout/<Category>/<SampleID>/<LayoutName>/Annotation/<SampleID>.json`  
记录一个样本在指定 layout 名称下的 3D 标签布局。`<LayoutName>` 使用 `layout1`、`layout2`、`layout3`。

- `sample_id`: 样本编号。
- `category`: 样本类别。
- `layout_level`: 布局等级名称，应与目录名一致，例如 `layout2`。
- `layout_type`: 布局类型说明。
- `normalization`: 物体归一化信息。
- `groups`: 零件标签组。每个组通常包含 `group_id`、零件 id、源 OBJ、目标 group、锚点、标签文字、标签框尺寸、标签中心和 leader line。

`Layout/<Category>/<SampleID>/<LayoutName>/Mutiviews/`  
保存该布局在多个视角下的渲染结果。标准视角为 `main`、`up`、`down`、`left`、`right`，另有 `combined` 拼接图。

`Layout/<Category>/<SampleID>/<LayoutName>/Obj-O/`  
保存带有标签和引线的输出 OBJ。`<SampleID>-<view>-O.obj` 是按对应视角生成的输出版本，`<SampleID>-O.mtl` 为共享材质文件。

`Obj-P/<Category>/<SampleID>/<SampleID>-P.obj`  
保存归一化后的零件物体 OBJ，通常作为布局生成和人工调整的基础 3D 模型。

`Points/<Category>/<SampleID>/`  
保存点云、点标签、法线或颜色等点级数据。输出点云使用与 `Obj-P` 相同的归一化参数，即 annotation 中的：

```text
normalized_xyz = (source_xyz - normalization.center_origin) / normalization.scale
```

`Obj-P` 的归一化尺度由源 OBJ 顶点决定，因此 `Obj-P` 顶点应落在单位球内。部分 `sample-points-all-*` 点云来自采样点文件，可能比 OBJ 顶点包围球略外扩；这类点仍使用同一套归一化变换，但个别点半径可能略大于 `1.0`。

`Text_objs/<Category>/<SampleID>/`  
保存每个标签文字对应的 3D 文本 OBJ，以及 `summary.json` 中的文字模型尺寸、包围盒和面板信息。

## Layout Levels

`Meta.json` 中的 `layout_levels` 定义了不同布局等级的语义：

```json
{
  "layout1": "manual_adjusted_ground_truth",
  "layout2": "rule_generated",
  "layout3": "noise_perturbed_bad"
}
```

常用约定如下：

- `layout1`: 人工微调后的 ground truth 布局。
- `layout2`: 规则自动生成的初始布局。
- `layout3`: 加入扰动后的低质量布局，可用于负样本或鲁棒性评估。

在人工调整工具中，输入只读取 `layout2`，保存后的人工结果写入 `layout1`。旧的数字目录名 `1`、`2`、`3` 不属于当前 3DLPD 结构。

## Meta.json Camera

`Meta.json` 的 `camera` 字段定义了数据集默认的透视相机和多视角配置。所有视角共享同一套内参，外参由 `position`、`x_view`、`y_view`、`z_view` 表示。

`camera` 自身表示 `main` 视角；`camera.other_camera` 下的子视角通常只保存各自的外参，未重复写出的内参沿用主相机字段。

示意结构如下：

```json
{
  "camera": {
    "type": "perspective",
    "camera_radius": 10.0,
    "focal_length_mm": 50.0,
    "sensor_width_mm": 36.0,
    "sensor_height_mm": 24.0,
    "near_clip": 1e-6,
    "far_clip": 1000000.0,
    "position": [5.7735, 5.7735, 5.7735],
    "x_view": [0.7071, 0.0, -0.7071],
    "y_view": [-0.4082, 0.8165, -0.4082],
    "z_view": [0.5774, 0.5774, 0.5774],
    "other_camera": {
      "up": {},
      "down": {},
      "left": {},
      "right": {}
    }
  }
}
```

### Intrinsic Parameters

- `type`: 相机类型，目前为 `perspective`。
- `camera_radius`: 相机中心到世界原点的距离。当前默认值为 `10.0`。
- `focal_length_mm`: 焦距，单位为毫米。
- `sensor_width_mm`: 传感器宽度，单位为毫米。
- `sensor_height_mm`: 传感器高度，单位为毫米。
- `near_clip`: 近裁剪面。
- `far_clip`: 远裁剪面。

投影时使用针孔相机模型。图像坐标原点在左上角，像素 x 向右增加，像素 y 向下增加。

### Extrinsic Parameters

- `position`: 相机中心在世界坐标系中的位置。
- `x_view`: 相机局部 x 轴，对应图像向右方向。
- `y_view`: 相机局部 y 轴，对应图像向上方向。
- `z_view`: 相机局部 +z 轴。数据集中相机看向 `-z_view` 方向，因此从相机看世界原点时，原点位于相机坐标系的负 z 方向。

三条 view 轴应互相正交并归一化。主视角的默认方向为：

```text
z_view = normalize([1, 1, 1])
position = camera_radius * z_view
```

因此主相机位于半径为 `10` 的球面上：

```text
position = [5.7735, 5.7735, 5.7735]
```

### Multi-View Cameras

主视角直接写在 `camera` 字段中，其余视角位于 `camera.other_camera`：

- `main`: 主视角。
- `up`: 相对主视角向上偏转。
- `down`: 相对主视角向下偏转。
- `left`: 相对主视角向左水平旋转。
- `right`: 相对主视角向右水平旋转。

当前默认视角均位于以世界原点为中心、半径为 `camera_radius` 的球面上。

这里的屏幕方向指主视角相机坐标系。`up` 和 `down` 是沿主视角的 `y_view` 方向偏转得到的：

```text
up   = normalize(main_z_view * cos(45°) + main_y_view * sin(45°))
down = normalize(main_z_view * cos(45°) - main_y_view * sin(45°))
```

`left` 和 `right` 是沿主视角的 `x_view` 方向偏转得到的：

```text
left  = normalize(main_z_view * cos(45°) - main_x_view * sin(45°))
right = normalize(main_z_view * cos(45°) + main_x_view * sin(45°))
```

对应位置为：

```text
main  = [5.7735,  5.7735, 5.7735]
up    = [1.1957,  9.8560, 1.1957]
down  = [6.9692, -1.6910, 6.9692]
left  = [-0.9175, 4.0825, 9.0825]
right = [9.0825, 4.0825, -0.9175]
```

这个设计使四个辅助视角都以主视角为参考：上下对应主视角的屏幕竖直轴，左右对应主视角的屏幕水平轴，而不是使用世界坐标轴做额外约束。

### Spherical Field

部分相机还包含 `spherical` 字段，用于以球坐标形式描述相机位置：

- `r`: 到世界原点的距离。
- `theta_degrees`: 极角。
- `phi_degrees`: 方位角。

按当前 `Meta.json` 约定，`theta_degrees = arccos(z / r)`，`phi_degrees = atan2(y, x)`。

`spherical` 主要用于阅读和调试。实际投影与渲染应优先使用 `position`、`x_view`、`y_view`、`z_view`。

## Projection Settings

`Meta.json` 的 `projection` 字段定义渲染图像和标签方向策略：

```json
{
  "image_width": 750,
  "image_height": 500,
  "label_orientation_mode": "adaptive"
}
```

- `image_width`: 单视角渲染图宽度。
- `image_height`: 单视角渲染图高度。
- `label_orientation_mode`: 标签朝向模式。`adaptive` 表示标签根据当前视角自适应朝向相机。

## Consistency Notes

维护数据时应保持以下约定：

- 保留类别层级：`<Category>/<SampleID>`。
- 保持样本编号不变。
- `Layout`、`Obj-P`、`Points`、`Text_objs` 四类目录应使用相同的 `<Category>/<SampleID>` 对齐。
- 数据集根目录应保留一份统一的 `Meta.json`。如果需要新增样本，应确保相机和投影参数与该 `Meta.json` 保持一致。
