Param(
    [string]$RootPath = (Get-Location).Path
)

<#
Genera un diccionario de datos en CSV (compatible con Excel) a partir de:
- solution.xml: lista de entidades incluidas en la solución (RootComponent type="1")
- customizations.xml: definición de entidades y sus atributos

Además, cruza con el uso real en el código (WebResources, Workflows, Formulas, appactions, CanvasApps)
para identificar tablas usadas y no usadas.

Salida:
- docs/diccionario_tablas_resumen.csv
- docs/diccionario_tablas_detalle.csv
- docs/tablas_no_usadas.csv
#>

function Find-File([string]$fileName, [string]$startPath) {
    $match = Get-ChildItem -Path $startPath -Recurse -File -Filter $fileName -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $match) {
        Write-Error "No se encontró $fileName bajo $startPath"
        return $null
    }
    return $match.FullName
}

function Get-Xml([string]$path) {
    try {
        return [xml](Get-Content -LiteralPath $path -Encoding UTF8)
    } catch {
        Write-Error "Error cargando XML: $path. $_"
        throw
    }
}

function Build-GlobalOptionSetIndex([xml]$customXml) {
    $index = @{}
    try {
        $nodes = Select-Xml -Xml $customXml -XPath "//optionset" -ErrorAction SilentlyContinue
        foreach ($n in $nodes) {
            $os = $n.Node
            try {
                $name = $os.Name
                if (-not [string]::IsNullOrWhiteSpace($name)) {
                    $count = 0
                    try { $count = ($os.options.option | Measure-Object).Count } catch {}
                    if (-not $count -or $count -eq 0) {
                        try { $count = ($os.states.state | Measure-Object).Count } catch {}
                    }
                    if (-not $count -or $count -eq 0) {
                        try { $count = ($os.statuses.status | Measure-Object).Count } catch {}
                    }
                    $index[$name] = [PSCustomObject]@{ Name = $name; OptionCount = $count }
                }
            } catch {}
        }
    } catch {}
    return $index
}

function Get-RootEntitiesFromSolution([xml]$solutionXml) {
    $nodes = Select-Xml -Xml $solutionXml -XPath "//RootComponent[@type='1']"
    $names = @()
    foreach ($n in $nodes) {
        $schemaName = $n.Node.schemaName
        if ([string]::IsNullOrWhiteSpace($schemaName)) { continue }
        $names += $schemaName
    }
    return ($names | Sort-Object -Unique)
}

function Get-EntitiesNodes([xml]$customXml) {
    # Intentar múltiples rutas comunes en customizations.xml
    $entities = @()
    $paths = @(
        "//ImportExportXml/Entities/Entity",
        "//Entities/Entity",
        "//Entity"
    )
    foreach ($xp in $paths) {
        $res = Select-Xml -Xml $customXml -XPath $xp -ErrorAction SilentlyContinue
        if ($res) { $entities += ($res | ForEach-Object { $_.Node }) }
        if ($entities.Count -gt 0) { break }
    }
    return $entities
}

function Get-EntityLogicalName($entityNode) {
    # Buscar el nombre lógico de la entidad
    # Común: entity info -> entity @Name
    try {
        $name = $entityNode.EntityInfo.entity.Name
        if (-not [string]::IsNullOrWhiteSpace($name)) { return $name }
    } catch {}
    # Alternativas
    try {
        $name = $entityNode.entity.Name
        if (-not [string]::IsNullOrWhiteSpace($name)) { return $name }
    } catch {}
    try {
        $name = $entityNode.Name
        if (-not [string]::IsNullOrWhiteSpace($name)) { return $name }
    } catch {}
    return $null
}

function Get-EntityDisplayName($entityNode) {
    # Intentar obtener la etiqueta localizada principal
    $displayName = $null
    # 1) <Name LocalizedName="..."> en el nodo de entidad
    try {
        $n = $entityNode.Name
        if ($n -and $n.LocalizedName) { $displayName = $n.LocalizedName }
    } catch {}
    # 2) <LocalizedNames><LocalizedName description="..." /></LocalizedNames>
    if (-not $displayName) {
        try {
            $candidate = $entityNode.EntityInfo.entity.LocalizedNames.LocalizedName | Select-Object -First 1
            if ($candidate -and $candidate.description) { $displayName = $candidate.description }
        } catch {}
    }
    if (-not $displayName) {
        try {
            $candidate = $entityNode.LocalizedNames.LocalizedName | Select-Object -First 1
            if ($candidate -and $candidate.description) { $displayName = $candidate.description }
        } catch {}
    }
    return $displayName
}

function Get-EntitySetName($entityNode) {
    try {
        $setName = $entityNode.EntityInfo.entity.EntitySetName
        if ($setName) { return $setName }
    } catch {}
    try {
        $setName = $entityNode.entity.EntitySetName
        if ($setName) { return $setName }
    } catch {}
    return $null
}

function Get-EntityOwnership($entityNode) {
    # OwnershipTypeMask o OwnershipType
    foreach ($path in @('EntityInfo.entity.OwnershipTypeMask','EntityInfo.entity.ownershiptype','EntityInfo.entity.OwnershipType','OwnershipTypeMask','ownershiptype','OwnershipType')) {
        try {
            $val = $entityNode
            foreach ($seg in ($path -split '\.')) { $val = $val.$seg }
            if ($val) { return $val.ToString() }
        } catch {}
    }
    return $null
}

function Get-AttributesNodes($entityNode) {
    $attrs = @()
    # Los atributos suelen estar bajo EntityInfo.entity.attributes.attribute
    $paths = @(
        'EntityInfo.entity.attributes.attribute',
        'entity.attributes.attribute',
        'Attributes.attribute',
        'attributes.attribute'
    )
    foreach ($xp in $paths) {
        try {
            $val = $entityNode
            foreach ($seg in ($xp -split '\.')) { $val = $val.$seg }
            if ($val) {
                # Asegurar que sumamos todos los nodos encontrados
                if ($val -is [System.Array]) { $attrs += $val } else { $attrs += $val }
            }
        } catch {}
    }
    return $attrs
}

function Get-AttrValue($obj, $pathCandidates) {
    foreach ($p in $pathCandidates) {
        try {
            $val = $obj
            foreach ($segment in ($p -split '\.')) { $val = $val.$segment }
            if ($val) { return $val }
        } catch {}
    }
    return $null
}

function Get-AttributeDisplayName($attrNode) {
    # Buscar etiqueta localizada
    $dn = $null
    # 1) Estructura clásica DisplayName/LocalizedLabels/Label
    try {
        $lab = $attrNode.DisplayName.LocalizedLabels.Label | Select-Object -First 1
        if ($lab) { if ($lab.description) { return $lab.description } elseif ($lab.Label) { return $lab.Label } }
    } catch {}
    # 2) LocalizedLabels a nivel de atributo
    try {
        $lab = $attrNode.LocalizedLabels.Label | Select-Object -First 1
        if ($lab) { if ($lab.description) { return $lab.description } elseif ($lab.Label) { return $lab.Label } }
    } catch {}
    # 3) displaynames/displayname (export estándar)
    try {
        $lab = $attrNode.displaynames.displayname | Select-Object -First 1
        if ($lab -and $lab.description) { return $lab.description }
    } catch {}
    # 4) UserLocalizedLabel
    try {
        $lab = $attrNode.DisplayName.UserLocalizedLabel
        if ($lab -and $lab.Label) { return $lab.Label }
    } catch {}
    return $dn
}

function Get-AttributeInfo($attrNode) {
    $logicalName = Get-AttrValue $attrNode @('AttributeInfo.attribute.LogicalName','LogicalName')
    $type = Get-AttrValue $attrNode @('AttributeInfo.attribute.Type','Type')
    $required = Get-AttrValue $attrNode @('AttributeInfo.attribute.RequiredLevel.Value','AttributeInfo.attribute.RequiredLevel','RequiredLevel')
    $isCustom = Get-AttrValue $attrNode @('AttributeInfo.attribute.IsCustomField','IsCustomField')
    $isAudit = Get-AttrValue $attrNode @('AttributeInfo.attribute.IsAuditEnabled.Value','AttributeInfo.attribute.IsAuditEnabled','IsAuditEnabled')
    $isSecured = Get-AttrValue $attrNode @('AttributeInfo.attribute.IsSecured','IsSecured')
    $introduced = Get-AttrValue $attrNode @('AttributeInfo.attribute.IntroducedVersion','IntroducedVersion')
    $displayName = Get-AttributeDisplayName $attrNode

    # OptionSet
    $optionSetName = $null
    $optionCount = $null
    # Nombre del OptionSet: múltiples ubicaciones posibles
    $optionSetName = Get-AttrValue $attrNode @('AttributeInfo.attribute.OptionSet.Name','AttributeInfo.attribute.OptionSetName','OptionSetName','optionset.Name')
    # Intentar contar opciones inline en el atributo
    try {
        $inlineOpts = Get-AttrValue $attrNode @('AttributeInfo.attribute.OptionSet.Options.Option','optionset.options.option')
        if ($inlineOpts) { $optionCount = ($inlineOpts | Measure-Object).Count }
    } catch {}
    # Fallback inline para state/status
    if (-not $optionCount -or $optionCount -eq 0) {
        try {
            $inlineStates = Get-AttrValue $attrNode @('optionset.states.state')
            if ($inlineStates) { $optionCount = ($inlineStates | Measure-Object).Count }
        } catch {}
    }
    if (-not $optionCount -or $optionCount -eq 0) {
        try {
            $inlineStatuses = Get-AttrValue $attrNode @('optionset.statuses.status')
            if ($inlineStatuses) { $optionCount = ($inlineStatuses | Measure-Object).Count }
        } catch {}
    }
    # Si no hay inline y tenemos nombre global, mirar en el índice global
    if (-not $optionCount -and $optionSetName -and $script:GlobalOptionSets -and $script:GlobalOptionSets.ContainsKey($optionSetName)) {
        try { $optionCount = $script:GlobalOptionSets[$optionSetName].OptionCount } catch {}
    }

    return [PSCustomObject]@{
        AttributeLogicalName = $logicalName
        DisplayName         = $displayName
        Type                = $type
        RequiredLevel       = $required
        IsCustomField       = $isCustom
        IsAuditEnabled      = $isAudit
        IsSecured           = $isSecured
        OptionSetName       = $optionSetName
        OptionCount         = $optionCount
        IntroducedVersion   = $introduced
    }
}

function Get-UsageForEntity([string]$root, [string]$entityName) {
    $dirs = @('WebResources','Workflows','Formulas','appactions','CanvasApps') | ForEach-Object { Join-Path $root $_ }
    $existingDirs = $dirs | Where-Object { Test-Path $_ }

    $totalCount = 0
    $filesWithMatch = New-Object System.Collections.Generic.HashSet[string]

    foreach ($d in $existingDirs) {
        try {
            $files = Get-ChildItem -Path $d -Recurse -File -ErrorAction SilentlyContinue
            if ($files) {
                $paths = $files | Select-Object -ExpandProperty FullName
                $matches = Select-String -Path $paths -Pattern $entityName -AllMatches -SimpleMatch -ErrorAction SilentlyContinue
                foreach ($m in $matches) {
                    if ($m) {
                        $totalCount += 1
                        if ($m.Path) { $null = $filesWithMatch.Add($m.Path) }
                    }
                }
            }
        } catch {}
    }

    $filesArr = @($filesWithMatch)
    return [PSCustomObject]@{
        UsageCount  = $totalCount
        UsageFiles  = ($filesArr -join '; ')
        UsedInApp   = [bool]($totalCount -gt 0)
    }
}

# Entradas y salida
$solutionPath = Find-File -fileName 'solution.xml' -startPath $RootPath
if (-not $solutionPath) { throw "No se encontró solution.xml" }

$customizationsPath = Find-File -fileName 'customizations.xml' -startPath $RootPath
if (-not $customizationsPath) { throw "No se encontró customizations.xml" }

$solutionXml = Get-Xml -path $solutionPath
$customXml = Get-Xml -path $customizationsPath

# Índice global de OptionSets para contar opciones cuando el atributo referencia un OptionSet por nombre
$script:GlobalOptionSets = Build-GlobalOptionSetIndex -customXml $customXml

$entityNames = Get-RootEntitiesFromSolution -solutionXml $solutionXml
Write-Host "Entidades en la solución: $($entityNames.Count)"

$entityNodes = Get-EntitiesNodes -customXml $customXml
if ($entityNodes.Count -eq 0) { throw "No se pudieron leer nodos de entidad en customizations.xml" }

# Índice por nombre lógico
$entityIndex = @{}
foreach ($en in $entityNodes) {
    $ln = Get-EntityLogicalName $en
    if ($ln) { $entityIndex[$ln] = $en }
}

# Preparar salida
$outDir = Join-Path $RootPath 'docs'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

$resumen = New-Object System.Collections.Generic.List[object]
$detalle = New-Object System.Collections.Generic.List[object]

foreach ($name in $entityNames) {
    $node = $null
    if ($entityIndex.ContainsKey($name)) { $node = $entityIndex[$name] }
    else {
        # Intentar variantes (algunos nombres pueden diferir por mayúsculas/minúsculas)
        $node = $entityNodes | Where-Object { (Get-EntityLogicalName $_) -eq $name } | Select-Object -First 1
    }

    $displayName = $null
    $setName = $null
    $ownership = $null
    $attrs = @()

    if ($node) {
        $displayName = Get-EntityDisplayName $node
        $setName = Get-EntitySetName $node
        $ownership = Get-EntityOwnership $node
        $attrs = Get-AttributesNodes $node
    }

    $attrCount = ($attrs | Measure-Object).Count
    $usage = Get-UsageForEntity -root $RootPath -entityName $name
    Write-Host ("Uso {0}: {1}" -f $name, $usage.UsageCount)

    # Agregar resumen
    $resumen.Add([PSCustomObject]@{
        EntityLogicalName = $name
        EntityDisplayName = $displayName
        EntitySetName     = $setName
        Ownership         = $ownership
        AttributesCount   = $attrCount
        UsedInApp         = $usage.UsedInApp
        UsageCount        = $usage.UsageCount
        UsageFiles        = $usage.UsageFiles
    })

    # Agregar detalle por atributo
    foreach ($a in $attrs) {
        $ai = Get-AttributeInfo $a
        $detalle.Add([PSCustomObject]@{
            EntityLogicalName   = $name
            AttributeLogicalName= $ai.AttributeLogicalName
            DisplayName         = $ai.DisplayName
            Type                = $ai.Type
            RequiredLevel       = $ai.RequiredLevel
            IsCustomField       = $ai.IsCustomField
            IsAuditEnabled      = $ai.IsAuditEnabled
            IsSecured           = $ai.IsSecured
            OptionSetName       = $ai.OptionSetName
            OptionCount         = $ai.OptionCount
            IntroducedVersion   = $ai.IntroducedVersion
        })
    }
}

$resumenPath = Join-Path $outDir 'diccionario_tablas_resumen.csv'
$detallePath = Join-Path $outDir 'diccionario_tablas_detalle.csv'
$noUsadasPath= Join-Path $outDir 'tablas_no_usadas.csv'

$resumen | Export-Csv -Path $resumenPath -NoTypeInformation -Encoding UTF8
$detalle | Export-Csv -Path $detallePath -NoTypeInformation -Encoding UTF8

# Tablas no usadas
$noUsadas = $resumen | Where-Object { -not $_.UsedInApp }
$noUsadas | Export-Csv -Path $noUsadasPath -NoTypeInformation -Encoding UTF8

Write-Host "Generados:" -ForegroundColor Green
Write-Host "  $resumenPath"
Write-Host "  $detallePath"
Write-Host "  $noUsadasPath"