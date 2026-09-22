"""能力注册表：每个 Tripo 能力一份声明（端点/参数/计费/输入输出要求）。

单一真相（SSOT）：服务端校验与提交、统一路由、前端元数据（GET /capabilities）三处共用。
新增能力 = 在这里加一条声明；mount 侧再把它加进前端默认渲染列表即可。

字段说明：
  input_kind  'model_task' 需要上游模型任务 id（走 id_field）
              'image'      需要 input（图片/模型 的 url / file_token / 上游 task_id）
              'none'       无输入（纯文生图，靠 prompt）
  id_field    上游任务 id 的字段名（refine 用 draft_model_task_id，其余 original_model_task_id）
  output      'model' 产物是模型（替换节点结果并进历史）
              'info'  产物是判定信息（如绑骨检测，展示文字不替换结果）
  engine      服务端默认/强制的 model_version
  cost        前端展示的估算点数（0 = 免费；以任务完成实际扣费为准）
"""
from dataclasses import dataclass


@dataclass(frozen=True)
class ParamSpec:
    name: str
    type: str                       # bool / int / float / str / enum / list（list 为逗号分隔字符串数组）
    label: str = ""
    default: object = None
    min: float = None
    max: float = None
    options: tuple = ()
    hint: str = ""

    def public(self):
        return {
            "name": self.name, "type": self.type, "label": self.label or self.name,
            "default": self.default, "min": self.min, "max": self.max,
            "options": list(self.options), "hint": self.hint,
        }


@dataclass(frozen=True)
class Capability:
    id: str
    group: str                      # mesh / export / rig / image / tool
    label: str
    endpoint: str
    cost: int = 5
    engine: str = ""
    engine_field: str = "model_version"   # V3 新端点（mesh/*、animations/*）引擎字段叫 model；legacy 端点（models/*）保留 V2 名 model_version
    enabled: bool = True
    desc: str = ""
    params: tuple = ()
    input_kind: str = "model_task"
    id_field: str = "original_model_task_id"   # V3 新端点输入字段叫 input（见各能力声明）；legacy 端点保留 V2 名
    output: str = "model"

    def public(self):
        return {
            "id": self.id, "group": self.group, "label": self.label, "cost": self.cost,
            "enabled": self.enabled, "desc": self.desc, "output": self.output,
            "input_kind": self.input_kind,
            "params": [p.public() for p in self.params],
        }


CONVERT_FORMATS = ("GLTF", "USDZ", "FBX", "OBJ", "STL", "3MF")
CONVERT_TEXTURE_FORMATS = ("BMP", "DPX", "HDR", "JPEG", "OPEN_EXR", "PNG", "TARGA", "TIFF", "WEBP")
RIG_TYPES = ("", "biped", "quadruped", "hexapod", "octopod", "avian", "serpentine", "aquatic", "others")
ANIMATIONS = (
    "preset:idle", "preset:walk", "preset:run", "preset:dive", "preset:climb", "preset:jump",
    "preset:slash", "preset:shoot", "preset:hurt", "preset:fall", "preset:turn",
    "preset:quadruped:walk", "preset:hexapod:walk", "preset:octopod:walk",
    "preset:serpentine:march", "preset:aquatic:march",
)
IMAGE_MODELS = (
    "seedream_v5", "seedream_v4",
    "banana", "banana_pro", "banana2",
    "chat_image_2", "chat_image_2.5_flare", "chat_image_2.5_sunburst",
    # chat_image_1（2026-10-23 退役）/ 1.5（2026-12-01 退役）不再收录
)

CAPABILITIES = {
    # ---------- 网格加工（mesh） ----------
    # 2026-09-23 字段名核对（官方 Rust SDK docs.rs/tripo-api）：V3 新端点 mesh/*、animations/*
    # 的输入字段是 `input`、引擎字段是 `model`（版本值见 crate::versions）；legacy 端点 models/*
    # （texture/convert/stylize/refine）保留 V2 字段名 original_model_task_id / model_version。
    "decimate": Capability(
        id="decimate", group="mesh", label="减面重拓扑", endpoint="/mesh/decimate", cost=30,
        id_field="input", engine="v2.0", engine_field="model",  # v2.0=智能重拓扑(30点,服务端默认)；v1.0=基础减面(10点,须带 face_limit)
        desc="把当前高模重拓扑压成低模，不用重新跑生成",
        params=(
            ParamSpec("face_limit", "int", "面数上限", default=-1, min=-1, max=20000, hint="-1 为自适应"),
            ParamSpec("quad", "bool", "四边面", default=False),
            ParamSpec("bake", "bool", "烘焙贴图", default=True),
            ParamSpec("part_names", "list", "指定部件", hint="逗号分隔，留空为整体处理"),
        ),
    ),
    "segment": Capability(
        # REST 契约（MeshSegmentationRequest）：仅 input + model 两个字段，
        # 无粒度/连通性参数（那是 ComfyUI 节点参数面）；版本唯一 v1.0-20250506
        id="segment", group="mesh", label="语义拆件", endpoint="/mesh/segment", cost=40,
        id_field="input", engine="v1.0-20250506", engine_field="model",
        desc="按语义把整体网格拆成可独立编辑的部件（身体/服饰/配件…），拆完可对部件补洞或分件处理",
        params=(),
    ),
    "complete": Capability(
        # 输入要求（官方注释）：input 必须是 mesh/segment 任务的 task_id——对普通生成模型直接补洞会被上游拒绝
        id="complete", group="mesh", label="补洞修复", endpoint="/mesh/complete", cost=50,
        id_field="input", engine="v1.0-20250506", engine_field="model",
        desc="补全缺失面片、修复破面（输入需为「语义拆件」的产物，请先对模型跑拆件）",
        params=(
            ParamSpec("part_names", "list", "指定部件", hint="逗号分隔，留空为整体修复"),
        ),
    ),
    "texture": Capability(
        id="texture", group="mesh", label="重贴图", endpoint="/models/texture", cost=5,
        engine="v3.0-20250812",
        desc="重新生成材质贴图（几何不变），支持文字引导与分部件",
        params=(
            ParamSpec("text_prompt", "str", "文字引导", hint="如：青铜器做旧质感"),
            ParamSpec("part_names", "list", "指定部件", hint="逗号分隔，留空为整体"),
            ParamSpec("bake", "bool", "烘焙贴图", default=True),
            ParamSpec("compress", "bool", "压缩输出", default=False),
        ),
    ),
    "refine": Capability(
        # 禁用原因（2026-09-23 真机确认）：/models/refine 是 legacy 端点，只接受
        # 「v2.0-20240919 之前版本模型产出的草稿任务」(draft_model_task_id)；V3 生成请求
        # 没有任何产出草稿的参数，当前阵容（H3.1/P2/P1）直出成品，提交必被上游拒绝
        # （报错文案笼统为 credit 不足，实际是任务形态不符）。
        id="refine", group="mesh", label="精修", endpoint="/models/refine", cost=5, enabled=False,
        desc="把草模精修成高精度模型（仅旧版草稿任务可用，当前模型阵容不支持）",
        id_field="draft_model_task_id",
        params=(),
    ),
    "stylize": Capability(
        id="stylize", group="mesh", label="风格化", endpoint="/models/stylize", cost=5,
        desc="把模型变成积木 / 体素 / Voronoi / Minecraft 风格",
        params=(
            ParamSpec("style", "enum", "风格", default="lego", options=("lego", "voxel", "voronoi", "minecraft")),
            ParamSpec("block_size", "int", "块大小", default=80, min=1, max=1000),
        ),
    ),
    # ---------- 绑骨动画（rig） ----------
    "rig_check": Capability(
        # CheckRiggableRequest：唯一字段 input（官方注释接受 task_id/file_token/URL）
        id="rig_check", group="rig", label="可绑骨检测", endpoint="/animations/rig-check", cost=0,
        id_field="input",
        desc="先判断当前模型能否绑骨，并给出建议骨骼类型（免费，不产生新模型）",
        output="info",
        params=(),
    ),
    "rig": Capability(
        # RigModelRequest：input + model + rig_type + spec + out_format。
        # 引擎版本（官方 versions::rig）：v2.5-20260210 支持全部骨骼类型；v1.0-20240301 仅 biped（服务端默认）
        id="rig", group="rig", label="自动绑骨", endpoint="/animations/rig", cost=25,
        id_field="input",
        desc="给模型挂骨架，出带骨骼的 GLB/FBX（完成后可直接做动画重定向）",
        params=(
            ParamSpec("rig_type", "enum", "骨骼类型", default="", options=RIG_TYPES,
                      hint="留空自动判断；建议先跑「可绑骨检测」"),
            ParamSpec("model", "enum", "绑骨引擎", default="v2.5-20260210",
                      options=("v2.5-20260210", "v1.0-20240301"),
                      hint="v1.0 仅支持双足（biped），非双足必须用 v2.5"),
            ParamSpec("spec", "enum", "骨骼规格", default="tripo", options=("tripo", "mixamo"),
                      hint="mixamo 兼容 Unity/Unreal 生态"),
            ParamSpec("out_format", "enum", "输出格式", default="glb", options=("glb", "fbx")),
        ),
    ),
    "retarget": Capability(
        # RetargetAnimationRequest：input（必须是已绑骨模型的 task_id）+ animation/动画字段
        # （单个动作键 animation 传字符串，多个动作键 animations 传数组——见 service._clean_params 特判）
        id="retarget", group="rig", label="动画重定向", endpoint="/animations/retarget", cost=10,
        id_field="input",
        desc="给已绑骨的模型套预设动作（走/跑/跳/攻击…16 种，可多选）。输入需为「自动绑骨」的产物，先跑绑骨",
        params=(
            ParamSpec("animation", "list", "动作", default="preset:walk", hint="逗号分隔可多选，如 preset:walk,preset:run"),
            ParamSpec("out_format", "enum", "输出格式", default="glb", options=("glb", "fbx")),
            ParamSpec("bake_animation", "bool", "烘焙动画", default=True),
            ParamSpec("export_with_geometry", "bool", "导出含几何", default=False, hint="关闭则只出动画片段"),
        ),
    ),
    # ---------- 导出（export） ----------
    "convert": Capability(
        id="convert", group="export", label="导出转换", endpoint="/models/convert", cost=5,
        desc="导出为其它格式，支持对称/压底/轴心/FBX 预设等 18 个参数",
        params=(
            ParamSpec("format", "enum", "格式", default="GLB", options=("GLB",) + CONVERT_FORMATS[1:], hint="GLB=GLTF 二进制"),
            ParamSpec("quad", "bool", "四边面", default=False),
            ParamSpec("force_symmetry", "bool", "强制对称", default=False),
            ParamSpec("face_limit", "int", "面数上限", default=-1, min=-1, max=500000),
            ParamSpec("flatten_bottom", "bool", "压平底部", default=False, hint="做摆件底座"),
            ParamSpec("flatten_bottom_threshold", "float", "压底阈值", default=0.01, min=0.0, max=1.0),
            ParamSpec("pivot_to_center_bottom", "bool", "轴心到底部中心", default=False, hint="进引擎摆放必备"),
            ParamSpec("scale_factor", "float", "缩放系数", default=1.0, min=0.0),
            ParamSpec("texture_size", "int", "贴图尺寸", default=4096, min=128, max=4096),
            ParamSpec("texture_format", "enum", "贴图格式", default="JPEG", options=CONVERT_TEXTURE_FORMATS),
            ParamSpec("with_animation", "bool", "保留动画", default=True),
            ParamSpec("pack_uv", "bool", "打包 UV", default=False),
            ParamSpec("bake", "bool", "烘焙", default=True),
            ParamSpec("part_names", "list", "指定部件", hint="逗号分隔，留空为整体"),
            ParamSpec("fbx_preset", "enum", "FBX 预设", default="blender", options=("blender", "mixamo", "3dsmax")),
            ParamSpec("export_vertex_colors", "bool", "导出顶点色", default=False),
            ParamSpec("export_orientation", "enum", "导出朝向", default="+x", options=("+x", "-x", "+y", "-y")),
            ParamSpec("animate_in_place", "bool", "原地动画", default=False),
        ),
    ),
    # ---------- 生图辅助（image）：API 已就绪，UI 将并入生成页 ----------
    "text_to_image": Capability(
        id="text_to_image", group="image", label="文生概念图", endpoint="/generation/text-to-image", cost=20,
        desc="先用提示词生成概念图，再拿去建模",
        input_kind="none",
        params=(
            ParamSpec("model", "enum", "图像模型", default="seedream_v4", options=IMAGE_MODELS),
            ParamSpec("prompt", "str", "提示词", hint="必填，支持中英文"),
            ParamSpec("size", "str", "尺寸", default="2048x2048", hint="如 2K / 4K / 2048x2048"),
            ParamSpec("output_format", "enum", "输出格式", default="png", options=("png", "jpeg")),
            ParamSpec("watermark", "bool", "AI 水印", default=False, hint="仅 seedream 系支持"),
        ),
    ),
    "image_to_image": Capability(
        id="image_to_image", group="image", label="图生图", endpoint="/generation/image-to-image", cost=20,
        desc="对输入图做风格化 / 编辑，输出新参考图",
        input_kind="image",
        params=(
            ParamSpec("model", "enum", "图像模型", default="seedream_v5", options=IMAGE_MODELS),
            ParamSpec("prompt", "str", "编辑指令", hint="如：把银色外套改成玻璃质感"),
            ParamSpec("size", "str", "尺寸", default="2048x2048"),
            ParamSpec("output_format", "enum", "输出格式", default="png", options=("png", "jpeg")),
        ),
    ),
    "image_to_multiview": Capability(
        id="image_to_multiview", group="image", label="单图生四视图", endpoint="/generation/image-to-multiview", cost=20,
        desc="一张图自动铺出四视图拼图，提高四视图建模成功率",
        input_kind="image",
        params=(
            ParamSpec("prompt", "str", "补充描述", hint="可选"),
            ParamSpec("size", "str", "尺寸", default="2048x2048"),
        ),
    ),
    "edit_multiview": Capability(
        id="edit_multiview", group="image", label="编辑四视图", endpoint="/generation/edit-multiview", cost=20,
        desc="对四视图输出做二次编辑后再建模",
        input_kind="image",
        params=(
            ParamSpec("prompt", "str", "编辑指令", hint="可选"),
        ),
    ),
    # ---------- 工具（tool） ----------
    "import_model": Capability(
        id="import_model", group="tool", label="导入外部模型", endpoint="/models/import", cost=0,
        desc="把本地/URL 模型导入 Tripo 任务链，即可对其做贴图/减面/绑骨等处理",
        input_kind="image",
        params=(),
    ),
}


def get_capability(cap_id: str):
    return CAPABILITIES.get(cap_id)


def list_public():
    """前端能力卡的元数据源。"""
    return [cap.public() for cap in CAPABILITIES.values()]
