/*
 * @Author: chenguofeng chenguofeng@bytedance.com
 * @Date: 2024-07-07 14:33:25
 * @LastEditors: chenguofeng chenguofeng@bytedance.com
 * @LastEditTime: 2024-07-08 00:08:13
 * @FilePath: \photo2reliefNegativeFilm\src\image2DataDeep\data2module.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
 
const { polyhedron } = require('@jscad/modeling').primitives
 


const stlSerializer = require('@jscad/stl-serializer')

const width =4
const height =4
const deep = [
    2,2,3,4,
    2,2,2,3,
    2,4,2,2,
    1,2,2,2,
]

if (deep.length != width*height) {
    console.error('像素尺寸不匹配')
}

if (width<=2||height<=2) {
    console.error('像素尺寸太小')
}

type PointXYZ = [number,number,number]
const points:Array<PointXYZ> = deep.map(
    (z,i)=>{
        const filledY =  Math.floor(  i/width )
        const y= height - filledY -1
        const x= i-filledY*width
        return [x,y,z]
    }
)
// 深度像素点
const deepPointNumbers = points.length

//四个底脚点
points.push(
    [0,height-1,0],[width-1,height-1,0],
    [0,0,0],[width-1,0,0],
) 
// 左上，右上，左下，右下
// -3   -2    -1   length

// 深度像素点 + 4个底部顶点


const walls:Array<Array<number>> = [
    [],
    [],
    [],
    [],
]  //上，下，左，右
const faces:Array<any>= []


const addFace = function(point:PointXYZ,res:string){
    // console.log(`points add ${point.map(i=>`[${points[i].toString()}]`)} for ${res}`)
    faces.push(point)
}


for (let i = 0; i < points.length; i++) {
    const point = points[i];
    const pointx =point[0]
    const pointy =point[1]
    // 只扫描深度像素点
    if (i>=deepPointNumbers) {
        break
    }
    if (pointy===height-1){  //y=height 上侧墙
        walls[0].push(i)
    }
    if (pointy===0){  //y=0 下侧墙
        walls[1].push(i)
    }
    if (pointx===0){  //x=0 左侧墙
        walls[2].push(i)
    }
    if (pointx===width-1){  //x=width 右侧墙
        walls[3].push(i)
    }
    // x/y
    if (
        pointy===height-1  // 上
        ||pointy===0  // 下
        ||pointx===0  // 左
        ||pointx===width-1  // 右
    ){
        // 4边不参与三角区构建
    }else{
        /**
         * O1-O2-O3  
         * O4-P0-O5
         * O6-O7-O8
         * P0 为当前点
         */
        //O1 方向 - O4 / O2  
        addFace([ i ,i-1-width ,i-1,],'顶面三角区')
        addFace( [ i , i-1-width, i-width],'顶面三角区')
        //O3 方向 - O5 / O2
        addFace([ i ,i+1-width ,i+1,],'顶面三角区')
        addFace([ i , i+1-width, i-width],'顶面三角区')
        //O6 方向 - O4 / O7
        addFace([ i ,i-1+width ,i-1,],'顶面三角区')
        addFace( [ i , i-1+width, i+width],'顶面三角区')
        //O8 方向 - O5 / O7 
        addFace([ i ,i+1+width ,i+1,],'顶面三角区')
        addFace( [ i , i+1+width, i+width],'顶面三角区')

    }
}


// console.log({walls})
//四面墙
walls.forEach( (wallPoint,pos) => {
    walls[pos].forEach( (wallPoint2Index,i)=>{
        if (i>0) { // 第一个点不操作
            const wallPoint1Index = walls[pos][i-1]
            const wallPoint1 = points[wallPoint1Index] //前置点
            const wallPoint2 = points[wallPoint2Index]  // 当前点
            //建立上一个点的投影
            const bottomPoint1:PointXYZ = [...wallPoint1]
            bottomPoint1[2] = 0 //z轴归零
            const pointIndex = points.push(bottomPoint1) -1  //添加投影坐标
            addFace([wallPoint1Index,wallPoint2Index,pointIndex],`add wall ${'上下左右'[pos]}`) // 前置点，当前点，前置点的投影
            if (i>1) { // 前置点已经建立过投影
                addFace([pointIndex-1,pointIndex,wallPoint1Index],`add wall ${'上下左右'[pos]} 补前`) // 前置点的前置点的投影，前置点的投影，前置点
            }
            if (i===wallPoint.length-1) { // 最后一个点
                const bottomPoint2:PointXYZ = [...wallPoint2] // 建立当前点的投影
                bottomPoint2[2] = 0 //z轴归零
                const pointIndex2 = points.push(bottomPoint2) -1  //添加投影坐标
                // 自行闭环
                addFace([pointIndex,pointIndex2,wallPoint2Index],`add wall ${'上下左右'[pos]} 自闭环`) // 前置点的投影，当前点的投影，当前点
            }
        }
    })
})

//底面
addFace([deepPointNumbers,deepPointNumbers+1,deepPointNumbers+2],`底面`)
addFace([deepPointNumbers+1,deepPointNumbers+2,deepPointNumbers+3],`底面`)

// faces.push(...walls)

// console.log({points,faces})


const myshape = polyhedron({points, faces, orientation: 'inward'})

const rawData = stlSerializer.serialize({binary: true}, myshape)

//in browser (with browserify etc)
const blob = new Blob(rawData)


export const sendStl =() => {
     return blob
}