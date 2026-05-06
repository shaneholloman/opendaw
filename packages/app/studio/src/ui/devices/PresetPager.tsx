import css from "./PresetPager.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon.tsx"
import {Lifecycle, Procedure} from "@opendaw/lib-std"
import {TextTooltip} from "@/ui/surface/TextTooltip"

const className = Html.adoptStyleSheet(css, "PresetPager")

type Construct = {
    lifecycle: Lifecycle
    onPresetNavigate: Procedure<-1 | 1>
}

export const PresetPager = ({lifecycle, onPresetNavigate}: Construct) => {
    const attachHandler = (element: Element, delta: -1 | 1) => {
        lifecycle.ownAll(
            Events.subscribe(element, "pointerdown", event => {
                event.preventDefault()
                event.stopPropagation()
            }),
            Events.subscribe(element, "click", event => {
                event.preventDefault()
                onPresetNavigate(delta)
            }),
            TextTooltip.default(element, () => "Navigate presets")
        )
    }
    return (
        <div className={className}>
            <Icon symbol={IconSymbol.SelectUp}
                  onInit={element => attachHandler(element, -1)}
            />
            <Icon symbol={IconSymbol.SelectDown}
                  onInit={element => attachHandler(element, 1)}/>
        </div>
    )
}
